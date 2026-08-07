import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  DockerEngineClient,
  DockerWorkerProvisioner,
  type DockerApi,
} from "../src/docker-engine.js";
import type { AgentPoolConfig } from "../src/pool-config.js";
import { loadPoolConfig } from "../src/pool-config.js";
import {
  PoolQueueFullError,
  WarmWorkerPool,
  type PoolWorker,
  type WorkerProvisioner,
} from "../src/pool.js";
import { createAgentPoolHttpServer, type AgentPoolHttpServer } from "../src/pool-server.js";

class FakeProvisioner implements WorkerProvisioner {
  nextId = 1;
  readonly destroyed: string[] = [];
  readonly provisioned: string[] = [];
  readonly unhealthy = new Set<string>();
  backendUrl = new URL("http://127.0.0.1:9999");

  async provision(): Promise<PoolWorker> {
    const id = `worker-${this.nextId++}`;
    this.provisioned.push(id);
    return {
      id,
      baseUrl: new URL(this.backendUrl),
      bearerToken: `backend-${id}`,
    };
  }

  async destroy(worker: PoolWorker): Promise<void> {
    this.destroyed.push(worker.id);
  }

  async healthy(worker: PoolWorker): Promise<boolean> {
    return !this.unhealthy.has(worker.id);
  }
}

const servers: Server[] = [];
const poolServers: AgentPoolHttpServer[] = [];
const pools: WarmWorkerPool[] = [];

afterEach(async () => {
  await Promise.all(poolServers.splice(0).map((server) => server.close()));
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  })));
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind a TCP port");
  }
  return address.port;
}

async function listenOnSocket(server: Server): Promise<string> {
  const socketPath = process.platform === "win32"
    ? `\\\\.\\pipe\\agent-slicer-${randomUUID()}`
    : `/tmp/agent-slicer-${randomUUID()}.sock`;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
}

function poolConfig(overrides: Partial<AgentPoolConfig> = {}): AgentPoolConfig {
  return {
    bindHost: "127.0.0.1",
    port: 8765,
    bearerToken: "p".repeat(48),
    poolId: "test-pool",
    allowedHosts: ["localhost", "127.0.0.1"],
    allowedOrigins: ["localhost", "127.0.0.1"],
    poolSize: 1,
    maxQueue: 2,
    acquireWaitMs: 1_000,
    leaseTtlMs: 60_000,
    retryDelayMs: 10,
    dockerSocketPath: "/var/run/docker.sock",
    dockerApiVersion: "1.43",
    workerImage: "agent-slicer:test",
    workerNetwork: "agent-slicer-pool",
    workerMcpPort: 8765,
    workerReadyTimeoutMs: 1_000,
    workerReadyPollMs: 10,
    workerShmBytes: 1024 * 1024 * 1024,
    workerEnvironment: [],
    timezone: "UTC",
    ...overrides,
  };
}

describe("warm worker pool", () => {
  it("leases workers exclusively and replaces rather than reuses released workers", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 2,
      retryDelayMs: 10,
    });
    pools.push(pool);
    await pool.start();

    const first = await pool.acquire(0);
    const waiting = pool.acquire(1_000);
    await pool.release(first.token, first.leaseId);
    const second = await waiting;

    expect(first.worker.id).toBe("worker-1");
    expect(second.worker.id).toBe("worker-2");
    expect(provisioner.destroyed).toEqual(["worker-1"]);
    expect(pool.leaseForToken(first.token)).toBeUndefined();
    expect(pool.leaseForToken(second.token)?.leaseId).toBe(second.leaseId);
  });

  it("bounds the FIFO wait queue", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
    });
    pools.push(pool);
    await pool.start();
    await pool.acquire(0);
    void pool.acquire(50).catch(() => undefined);
    await expect(pool.acquire(50)).rejects.toBeInstanceOf(PoolQueueFullError);
  });

  it("expires idle leases and warms a clean replacement", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 20,
      maxQueue: 1,
      retryDelayMs: 5,
    });
    pools.push(pool);
    await pool.start();
    const expired = await pool.acquire(0);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const replacement = await pool.acquire(500);

    expect(pool.leaseForToken(expired.token)).toBeUndefined();
    expect(provisioner.destroyed).toContain("worker-1");
    expect(replacement.worker.id).toBe("worker-2");
  });

  it("recycles a warm worker that became unhealthy before leasing it", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
      retryDelayMs: 5,
    });
    pools.push(pool);
    await pool.start();
    provisioner.unhealthy.add("worker-1");

    const lease = await pool.acquire(500);

    expect(lease.worker.id).toBe("worker-2");
    expect(provisioner.destroyed).toContain("worker-1");
    expect(pool.stats()).toMatchObject({ ready: 0, leased: 1, warming: 0 });
  });
});

describe("pool HTTP gateway", () => {
  it("authenticates leases, rewrites backend auth, proxies, and revokes on release", async () => {
    let backendAuthorization: string | undefined;
    let backendPath: string | undefined;
    const backend = createServer((request, response) => {
      backendAuthorization = request.headers.authorization;
      backendPath = request.url;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ proxied: true }));
    });
    servers.push(backend);
    const backendPort = await listen(backend);

    const provisioner = new FakeProvisioner();
    provisioner.backendUrl = new URL(`http://127.0.0.1:${backendPort}`);
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
    });
    pools.push(pool);
    await pool.start();
    const config = poolConfig();
    const gateway = createAgentPoolHttpServer(config, pool);
    poolServers.push(gateway);
    const gatewayPort = await listen(gateway.server);
    const origin = `http://127.0.0.1:${gatewayPort}`;

    const acquired = await fetch(`${origin}/leases`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ wait_ms: 0 }),
    });
    expect(acquired.status).toBe(201);
    const lease = await acquired.json() as {
      lease_id: string;
      token: string;
      release_path: string;
    };
    const proxied = await fetch(`${origin}/mcp?request=1`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}` },
      body: "payload",
    });
    expect(proxied.status).toBe(200);
    await expect(proxied.json()).resolves.toEqual({ proxied: true });
    expect(backendAuthorization).toBe("Bearer backend-worker-1");
    expect(backendPath).toBe("/mcp?request=1");

    const released = await fetch(`${origin}${lease.release_path}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${lease.token}` },
    });
    expect(released.status).toBe(202);
    const revoked = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}` },
    });
    expect(revoked.status).toBe(401);
    expect(provisioner.destroyed).toContain("worker-1");
  });

  it("never accepts the pool management token as a worker lease", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
    });
    pools.push(pool);
    await pool.start();
    const config = poolConfig();
    const gateway = createAgentPoolHttpServer(config, pool);
    poolServers.push(gateway);
    const gatewayPort = await listen(gateway.server);
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.bearerToken}` },
    });
    expect(response.status).toBe(401);
  });
});

describe("Docker worker provisioner", () => {
  it("reconciles owned orphans and creates isolated anonymous workers", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const docker: DockerApi = {
      async request(method, path, body) {
        calls.push({ method, path, body });
        if (path.startsWith("/containers/create")) {
          return { Id: "container-1" };
        }
        if (path.startsWith("/containers/json")) {
          return [{ Id: "orphan-1" }, { Id: "orphan-2" }];
        }
        if (path === "/containers/container-1/json") {
          return {
            NetworkSettings: {
              Networks: { "agent-slicer-pool": { IPAddress: "172.30.0.4" } },
            },
          };
        }
        return null;
      },
    };
    const provisioner = new DockerWorkerProvisioner(docker, {
      image: "agent-slicer:test",
      network: "agent-slicer-pool",
      poolId: "test-pool",
      readyTimeoutMs: 100,
      readyPollMs: 1,
      shmBytes: 1024 * 1024 * 1024,
      checkReady: async () => true,
    });

    await expect(provisioner.reconcile()).resolves.toBe(2);
    const list = calls.find((call) => call.path.startsWith("/containers/json"));
    const filters = new URL(`http://docker${list?.path}`).searchParams.get("filters");
    expect(JSON.parse(filters ?? "null")).toEqual({
      label: [
        "com.3dstisk.agent-slicer.pool-managed=true",
        "com.3dstisk.agent-slicer.pool-id=test-pool",
      ],
    });
    expect(calls).toContainEqual({
      method: "DELETE",
      path: "/containers/orphan-1?force=true&v=true",
      body: undefined,
    });
    expect(calls).toContainEqual({
      method: "DELETE",
      path: "/containers/orphan-2?force=true&v=true",
      body: undefined,
    });

    const worker = await provisioner.provision();
    expect(worker.id).toBe("container-1");
    expect(worker.baseUrl.href).toBe("http://172.30.0.4:8765/");
    await expect(provisioner.healthy(worker)).resolves.toBe(true);
    const create = calls.find((call) => call.path.startsWith("/containers/create"));
    expect(create?.body).toMatchObject({
      Image: "agent-slicer:test",
      HostConfig: {
        AutoRemove: false,
        NetworkMode: "agent-slicer-pool",
      },
      NetworkingConfig: {
        EndpointsConfig: { "agent-slicer-pool": {} },
      },
      Labels: {
        "com.3dstisk.agent-slicer.pool-managed": "true",
        "com.3dstisk.agent-slicer.pool-id": "test-pool",
      },
    });
    expect(create?.body).not.toHaveProperty("HostConfig.Binds");
    expect((create?.body as { Env: string[] }).Env).toContain(
      `AGENT_SLICER_TOKEN=${worker.bearerToken}`,
    );

    await provisioner.destroy(worker);
    expect(calls).toContainEqual({
      method: "DELETE",
      path: "/containers/container-1?force=true&v=true",
      body: undefined,
    });
  });
});

describe("Docker Engine client", () => {
  it("negotiates the API version once for concurrent requests", async () => {
    const paths: string[] = [];
    const daemon = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/version"
        ? { ApiVersion: "1.51", MinAPIVersion: "1.44" }
        : []));
    });
    servers.push(daemon);
    const socketPath = await listenOnSocket(daemon);
    const docker = new DockerEngineClient({ socketPath });

    await expect(Promise.all([
      docker.request("GET", "/containers/json"),
      docker.request("GET", "/containers/json"),
    ])).resolves.toEqual([[], []]);

    expect(paths).toEqual([
      "/version",
      "/v1.44/containers/json",
      "/v1.44/containers/json",
    ]);
  });

  it("retries API discovery after a transient failure", async () => {
    let versionRequests = 0;
    const paths: string[] = [];
    const daemon = createServer((request, response) => {
      paths.push(request.url ?? "");
      if (request.url === "/version" && versionRequests++ === 0) {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "temporary failure" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(request.url === "/version"
        ? { ApiVersion: "1.43" }
        : []));
    });
    servers.push(daemon);
    const socketPath = await listenOnSocket(daemon);
    const docker = new DockerEngineClient({ socketPath });

    await expect(docker.request("GET", "/containers/json")).rejects.toThrow("temporary failure");
    await expect(docker.request("GET", "/containers/json")).resolves.toEqual([]);

    expect(versionRequests).toBe(2);
    expect(paths).toEqual(["/version", "/version", "/v1.43/containers/json"]);
  });

  it("honors an explicit API version without auto-detection", async () => {
    const paths: string[] = [];
    const daemon = createServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    servers.push(daemon);
    const socketPath = await listenOnSocket(daemon);
    const docker = new DockerEngineClient({ socketPath, apiVersion: "1.44" });

    await expect(docker.request("GET", "/info")).resolves.toEqual({});

    expect(paths).toEqual(["/v1.44/info"]);
  });
});

describe("pool configuration", () => {
  it("requires a strong management token and validates worker environment", () => {
    expect(() => loadPoolConfig({ AGENT_SLICER_POOL_TOKEN: "short" })).toThrow(
      "at least 32 characters",
    );
    expect(() => loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_WORKER_ENV: "NOT AN ENV",
    })).toThrow("NAME=value");
    expect(() => loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_WORKER_ENV: "AGENT_SLICER_TOKEN=override",
    })).toThrow("pool-managed settings");
    const config = loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_SIZE: "3",
      AGENT_SLICER_POOL_ID: "production-a",
      AGENT_SLICER_POOL_WORKER_ENV: "ORCA_SCREEN_WIDTH=1280\nORCA_SCREEN_HEIGHT=720",
    });
    expect(config).toMatchObject({
      poolSize: 3,
      poolId: "production-a",
      workerEnvironment: ["ORCA_SCREEN_WIDTH=1280", "ORCA_SCREEN_HEIGHT=720"],
    });
    expect(config.dockerApiVersion).toBeUndefined();
    expect(loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_DOCKER_API_VERSION: "1.44",
    }).dockerApiVersion).toBe("1.44");
    expect(() => loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_ID: "invalid pool id",
    })).toThrow("AGENT_SLICER_POOL_ID");
  });
});
