import { randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";

import type { PoolWorker, WorkerProvisioner } from "./pool.js";

const MAX_DOCKER_RESPONSE_BYTES = 1024 * 1024;
const MAX_SUPPORTED_DOCKER_API_VERSION = "1.44";

export interface DockerApi {
  request(
    method: string,
    path: string,
    body?: unknown,
    acceptedStatuses?: readonly number[],
  ): Promise<unknown>;
}

export interface DockerEngineClientOptions {
  socketPath: string;
  apiVersion?: string;
}

export class DockerEngineClient implements DockerApi {
  private apiPrefix: string | undefined;
  private apiPrefixPromise: Promise<string> | undefined;

  constructor(private readonly options: DockerEngineClientOptions) {
    if (options.apiVersion !== undefined) {
      this.apiPrefix = DockerEngineClient.versionPrefix(options.apiVersion);
    }
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    acceptedStatuses: readonly number[] = [200],
  ): Promise<unknown> {
    const apiPrefix = await this.resolveApiPrefix();
    return this.requestPath(method, `${apiPrefix}${path}`, body, acceptedStatuses);
  }

  private async resolveApiPrefix(): Promise<string> {
    if (this.apiPrefix !== undefined) {
      return this.apiPrefix;
    }
    const pending = this.apiPrefixPromise ??= this.discoverApiPrefix();
    try {
      const apiPrefix = await pending;
      this.apiPrefix = apiPrefix;
      return apiPrefix;
    } catch (error) {
      if (this.apiPrefixPromise === pending) {
        this.apiPrefixPromise = undefined;
      }
      throw error;
    }
  }

  private async discoverApiPrefix(): Promise<string> {
    const version = await this.requestPath("GET", "/version", undefined, [200]);
    if (typeof version !== "object" || version === null ||
        !("ApiVersion" in version) || typeof version.ApiVersion !== "string") {
      throw new Error("Docker Engine returned an unexpected version response");
    }
    const minApiVersion = "MinAPIVersion" in version ? version.MinAPIVersion : undefined;
    if (minApiVersion !== undefined && typeof minApiVersion !== "string") {
      throw new Error("Docker Engine returned an unexpected version response");
    }
    const apiVersion = DockerEngineClient.compareVersions(
        version.ApiVersion,
        MAX_SUPPORTED_DOCKER_API_VERSION,
      ) < 0
      ? version.ApiVersion
      : MAX_SUPPORTED_DOCKER_API_VERSION;
    if (minApiVersion !== undefined &&
        DockerEngineClient.compareVersions(apiVersion, minApiVersion) < 0) {
      throw new Error(
        `Docker Engine requires API ${minApiVersion} or newer, ` +
        `but AgentSlicer supports up to API ${MAX_SUPPORTED_DOCKER_API_VERSION}`,
      );
    }
    return DockerEngineClient.versionPrefix(apiVersion);
  }

  private static versionPrefix(apiVersion: string): string {
    DockerEngineClient.versionParts(apiVersion);
    return `/v${apiVersion}`;
  }

  private static compareVersions(left: string, right: string): number {
    const [leftMajor, leftMinor] = DockerEngineClient.versionParts(left);
    const [rightMajor, rightMinor] = DockerEngineClient.versionParts(right);
    return leftMajor - rightMajor || leftMinor - rightMinor;
  }

  private static versionParts(apiVersion: string): [number, number] {
    const match = /^(\d+)\.(\d+)$/.exec(apiVersion);
    if (match === null) {
      throw new Error("Docker Engine API version must use major.minor format");
    }
    return [Number(match[1]), Number(match[2])];
  }

  private requestPath(
    method: string,
    path: string,
    body: unknown,
    acceptedStatuses: readonly number[],
  ): Promise<unknown> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const outgoing = request({
        socketPath: this.options.socketPath,
        method,
        path,
        headers: payload === undefined
          ? { accept: "application/json" }
          : {
              accept: "application/json",
              "content-type": "application/json",
              "content-length": payload.length,
            },
      });
      outgoing.once("error", reject);
      outgoing.once("response", (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_DOCKER_RESPONSE_BYTES) {
            response.destroy(new Error("Docker Engine response exceeded 1 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.once("error", reject);
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw);
            } catch {
              reject(new Error(`Docker Engine returned invalid JSON (${status})`));
              return;
            }
          }
          if (!acceptedStatuses.includes(status)) {
            const message = typeof parsed === "object" && parsed !== null &&
                "message" in parsed && typeof parsed.message === "string"
              ? parsed.message
              : `Docker Engine request failed with status ${status}`;
            reject(new Error(message));
            return;
          }
          resolve(parsed);
        });
      });
      if (payload !== undefined) {
        outgoing.write(payload);
      }
      outgoing.end();
    });
  }
}

export interface DockerWorkerProvisionerOptions {
  image: string;
  network: string;
  poolId: string;
  mcpPort?: number;
  readyTimeoutMs: number;
  readyPollMs: number;
  shmBytes: number;
  timezone?: string;
  workerEnvironment?: readonly string[];
  checkReady?: (baseUrl: URL) => Promise<boolean>;
}

interface CreatedContainer {
  Id?: unknown;
}

interface InspectedContainer {
  NetworkSettings?: {
    Networks?: Record<string, { IPAddress?: unknown }>;
  };
}

interface ContainerSummary {
  Id?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Docker Engine returned an unexpected object");
  }
  return value as Record<string, unknown>;
}

async function defaultReadyCheck(baseUrl: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL("/readyz", baseUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export class DockerWorkerProvisioner implements WorkerProvisioner {
  private readonly mcpPort: number;

  constructor(
    private readonly docker: DockerApi,
    private readonly options: DockerWorkerProvisionerOptions,
  ) {
    this.mcpPort = options.mcpPort ?? 8765;
  }

  async provision(): Promise<PoolWorker> {
    const name = `agent-slicer-worker-${randomUUID()}`;
    const bearerToken = randomBytes(32).toString("base64url");
    let containerId: string | undefined;
    try {
      const created = objectValue(await this.docker.request(
        "POST",
        `/containers/create?name=${encodeURIComponent(name)}`,
        {
          Image: this.options.image,
          Env: [
            "PUID=1000",
            "PGID=1000",
            `TZ=${this.options.timezone ?? "UTC"}`,
            "AGENT_SLICER_MCP_HOST=0.0.0.0",
            `AGENT_SLICER_MCP_PORT=${this.mcpPort}`,
            `AGENT_SLICER_TOKEN=${bearerToken}`,
            "AGENT_SLICER_ALLOWED_HOSTS=localhost,127.0.0.1,[::1]",
            "AGENT_SLICER_ALLOWED_ORIGINS=localhost,127.0.0.1,[::1]",
            "HARDEN_DESKTOP=true",
            "START_DOCKER=false",
            "SELKIES_FILE_TRANSFERS=none",
            "SELKIES_COMMAND_ENABLED=false",
            "SELKIES_ENABLE_SHARING=false",
            ...(this.options.workerEnvironment ?? []),
          ],
          Labels: {
            "com.3dstisk.agent-slicer.pool-managed": "true",
            "com.3dstisk.agent-slicer.pool-id": this.options.poolId,
          },
          HostConfig: {
            AutoRemove: false,
            NetworkMode: this.options.network,
            ShmSize: this.options.shmBytes,
            SecurityOpt: ["no-new-privileges:true"],
          },
          NetworkingConfig: {
            EndpointsConfig: {
              [this.options.network]: {},
            },
          },
        },
        [201],
      )) as CreatedContainer;
      if (typeof created.Id !== "string" || created.Id.length === 0) {
        throw new Error("Docker Engine did not return a container id");
      }
      containerId = created.Id;
      await this.docker.request(
        "POST",
        `/containers/${encodeURIComponent(containerId)}/start`,
        undefined,
        [204, 304],
      );
      const baseUrl = await this.workerBaseUrl(containerId);
      await this.waitUntilReady(baseUrl);
      return { id: containerId, baseUrl, bearerToken };
    } catch (error) {
      if (containerId !== undefined) {
        await this.destroyById(containerId);
      }
      throw error;
    }
  }

  async destroy(worker: PoolWorker): Promise<void> {
    await this.destroyById(worker.id);
  }

  async healthy(worker: PoolWorker): Promise<boolean> {
    const check = this.options.checkReady ?? defaultReadyCheck;
    return check(worker.baseUrl);
  }

  async reconcile(): Promise<number> {
    const filters = encodeURIComponent(JSON.stringify({
      label: [
        "com.3dstisk.agent-slicer.pool-managed=true",
        `com.3dstisk.agent-slicer.pool-id=${this.options.poolId}`,
      ],
    }));
    const listed = await this.docker.request(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
      undefined,
      [200],
    );
    if (!Array.isArray(listed)) {
      throw new Error("Docker Engine returned an unexpected container list");
    }
    const containerIds = listed.map((value) => {
      const summary = objectValue(value) as ContainerSummary;
      if (typeof summary.Id !== "string" || summary.Id.length === 0) {
        throw new Error("Docker Engine returned a container without an id");
      }
      return summary.Id;
    });
    await Promise.all(containerIds.map((containerId) =>
      this.docker.request(
        "DELETE",
        `/containers/${encodeURIComponent(containerId)}?force=true&v=true`,
        undefined,
        [204, 404],
      )));
    return containerIds.length;
  }

  private async destroyById(containerId: string): Promise<void> {
    try {
      await this.docker.request(
        "DELETE",
        `/containers/${encodeURIComponent(containerId)}?force=true&v=true`,
        undefined,
        [204, 404],
      );
    } catch {
      // A failed cleanup is retried by Docker/operator reconciliation; never
      // make a released worker eligible for another lease.
    }
  }

  private async workerBaseUrl(containerId: string): Promise<URL> {
    const inspected = objectValue(await this.docker.request(
      "GET",
      `/containers/${encodeURIComponent(containerId)}/json`,
      undefined,
      [200],
    )) as InspectedContainer;
    const address = inspected.NetworkSettings?.Networks?.[this.options.network]?.IPAddress;
    if (typeof address !== "string" || address.length === 0) {
      throw new Error("AgentSlicer worker has no pool-network address");
    }
    const host = address.includes(":") ? `[${address}]` : address;
    return new URL(`http://${host}:${this.mcpPort}`);
  }

  private async waitUntilReady(baseUrl: URL): Promise<void> {
    const deadline = Date.now() + this.options.readyTimeoutMs;
    const check = this.options.checkReady ?? defaultReadyCheck;
    while (Date.now() < deadline) {
      if (await check(baseUrl)) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.options.readyPollMs));
    }
    throw new Error("AgentSlicer worker did not become ready before timeout");
  }
}
