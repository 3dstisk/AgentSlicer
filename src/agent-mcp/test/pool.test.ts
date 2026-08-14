import { randomUUID } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";

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
import { StaticWorkerProvisioner } from "../src/static-workers.js";

class FakeProvisioner implements WorkerProvisioner {
  nextId = 1;
  readonly destroyed: string[] = [];
  readonly destroyAttempts: string[] = [];
  readonly provisioned: string[] = [];
  readonly unhealthy = new Set<string>();
  destroyFailures = 0;
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

  async reclaim(worker: PoolWorker): Promise<void> {
    this.destroyAttempts.push(worker.id);
    if (this.destroyFailures > 0) {
      --this.destroyFailures;
      throw new Error("worker cleanup failed");
    }
    this.destroyed.push(worker.id);
  }

  async healthy(worker: PoolWorker): Promise<boolean> {
    return !this.unhealthy.has(worker.id);
  }
}

class FlakyProvisioner extends FakeProvisioner {
  provisionFailures = 0;

  override async provision(): Promise<PoolWorker> {
    if (this.provisionFailures > 0) {
      --this.provisionFailures;
      throw new Error("worker startup failed");
    }
    return super.provision();
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
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
    workerUrls: [new URL("http://worker-1:8765")],
    workerToken: "w".repeat(48),
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

  it("does not publish an unhealthy provisioned worker as available capacity", async () => {
    const provisioner = new FakeProvisioner();
    provisioner.unhealthy.add("worker-1");
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
      retryDelayMs: 5,
    });
    pools.push(pool);

    await pool.start();
    await waitFor(() => provisioner.provisioned.includes("worker-2"));

    expect(provisioner.destroyed).toContain("worker-1");
    expect(pool.stats()).toMatchObject({ ready: 1, leased: 0, warming: 0 });
    const lease = await pool.acquire(0);
    expect(lease.worker.id).toBe("worker-2");
  });

  it("removes an aborted acquisition and deterministically replaces a cancelled lease", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 2,
      retryDelayMs: 5,
    });
    pools.push(pool);
    await pool.start();
    const lease = await pool.acquire(0);
    const abandoned = new AbortController();
    const acquisition = pool.acquire(1_000, abandoned.signal);
    await waitFor(() => pool.stats().queued === 1);

    abandoned.abort();
    await expect(acquisition).rejects.toThrow("abandoned");
    expect(pool.stats().queued).toBe(0);

    const replacement = pool.acquire(1_000);
    await expect(pool.release(lease.token, lease.leaseId)).resolves.toBe(true);
    await expect(replacement).resolves.toMatchObject({ worker: { id: "worker-2" } });
    expect(provisioner.destroyed.filter((id) => id === "worker-1")).toHaveLength(1);
  });

  it("retries failed reclamation without making the abandoned worker allocatable", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
      retryDelayMs: 5,
    });
    pools.push(pool);
    await pool.start();
    const lease = await pool.acquire(0);
    provisioner.destroyFailures = 1;

    await expect(pool.release(lease.token, lease.leaseId)).resolves.toBe(true);
    expect(pool.leaseForToken(lease.token)).toBeUndefined();
    expect(pool.stats().unhealthy).toBe(1);
    const replacement = await pool.acquire(1_000);
    expect(replacement.worker.id).toBe("worker-2");
    await waitFor(() => provisioner.destroyed.includes("worker-1"));

    expect(provisioner.destroyAttempts.filter((id) => id === "worker-1")).toHaveLength(2);
    expect(pool.stats().unhealthy).toBe(0);
    expect(pool.metrics().workerReclamationFailures).toBe(1);
    expect(pool.metrics().workerReclamations).toMatchObject({ released: 1 });
  });
});

describe("pool HTTP gateway", () => {
  it("returns typed retryable capacity failures with safe counts and retry guidance", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
    });
    pools.push(pool);
    await pool.start();
    await pool.acquire(0);
    const config = poolConfig();
    const gateway = createAgentPoolHttpServer(config, pool);
    poolServers.push(gateway);
    const gatewayPort = await listen(gateway.server);

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/leases`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ wait_ms: 0 }),
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "capacity_unavailable",
        message: expect.any(String),
      },
      retryable: true,
      retryAfterMs: expect.any(Number),
      pool: {
        ready: 0,
        leased: 1,
        starting: 0,
        unhealthy: 0,
      },
    });
  });

  it("reports a full lease queue as a typed retryable allocation failure", async () => {
    const provisioner = new FakeProvisioner();
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
    });
    pools.push(pool);
    await pool.start();
    await pool.acquire(0);
    void pool.acquire(1_000).catch(() => undefined);
    await waitFor(() => pool.stats().queued === 1);
    const config = poolConfig();
    const gateway = createAgentPoolHttpServer(config, pool);
    poolServers.push(gateway);
    const gatewayPort = await listen(gateway.server);

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/leases`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.bearerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ wait_ms: 100 }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "lease_queue_full", message: expect.any(String) },
      retryable: true,
      retryAfterMs: expect.any(Number),
      pool: { ready: 0, leased: 1, starting: 0, unhealthy: 0 },
    });
  });

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

  it("preserves structured MCP job errors through the lease proxy", async () => {
    const job = {
      job_id: "slice-job-1",
      state: "failed",
      error: {
        code: "slice_failed",
        message: "Native slicer failed",
        details: { plate_index: 0 },
      },
    };
    const backend = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(job));
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
      headers: { authorization: `Bearer ${config.bearerToken}` },
      body: JSON.stringify({ wait_ms: 0 }),
    });
    const lease = await acquired.json() as { token: string };

    const result = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}` },
      body: JSON.stringify({ method: "job_get", params: { job_id: job.job_id } }),
    });

    expect(result.status).toBe(200);
    await expect(result.json()).resolves.toEqual(job);
  });

  it("renews a long-running lease only through an explicit heartbeat and later reclaims it", async () => {
    const backend = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ state: "running" }));
    });
    servers.push(backend);
    const backendPort = await listen(backend);
    const provisioner = new FakeProvisioner();
    provisioner.backendUrl = new URL(`http://127.0.0.1:${backendPort}`);
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 300,
      maxQueue: 1,
      retryDelayMs: 5,
    });
    pools.push(pool);
    await pool.start();
    const config = poolConfig({ leaseTtlMs: 300 });
    const gateway = createAgentPoolHttpServer(config, pool);
    poolServers.push(gateway);
    const gatewayPort = await listen(gateway.server);
    const origin = `http://127.0.0.1:${gatewayPort}`;
    const acquired = await fetch(`${origin}/leases`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.bearerToken}` },
      body: JSON.stringify({ wait_ms: 0 }),
    });
    const lease = await acquired.json() as { lease_id: string; token: string; expires_at: string };
    await new Promise((resolve) => setTimeout(resolve, 50));

    const heartbeat = await fetch(`${origin}/leases/${lease.lease_id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${lease.token}` },
    });
    expect(heartbeat.status).toBe(200);
    await expect(heartbeat.json()).resolves.toMatchObject({
      lease_id: lease.lease_id,
      renewed: true,
      expires_at: expect.any(String),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const polling = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}` },
    });
    expect(polling.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 350));
    const expired = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${lease.token}` },
    });
    expect(expired.status).toBe(401);
    await waitFor(() => provisioner.destroyed.includes("worker-1"));
  });

  it("reconnects separate proxy requests with the same lease token and job id", async () => {
    const calls: Array<{ authorization?: string; body: string }> = [];
    let observeInterruptedRequest: (() => void) | undefined;
    const interruptedRequest = new Promise<void>((resolve) => {
      observeInterruptedRequest = resolve;
    });
    const backend = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        calls.push({ authorization: request.headers.authorization, body });
        const params = JSON.parse(body) as {
          method: string;
          params?: { job_id?: string; interrupt?: boolean };
        };
        if (params.params?.interrupt === true) {
          observeInterruptedRequest?.();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(params.method === "slice_start"
          ? { job_id: "slice-job-1", state: "running" }
          : { job_id: params.params?.job_id, state: "succeeded" }));
      });
    });
    servers.push(backend);
    const backendPort = await listen(backend);
    const provisioner = new FakeProvisioner();
    provisioner.backendUrl = new URL(`http://127.0.0.1:${backendPort}`);
    const pool = new WarmWorkerPool(provisioner, { size: 1, leaseTtlMs: 60_000, maxQueue: 1 });
    pools.push(pool);
    await pool.start();
    const config = poolConfig();
    const gateway = createAgentPoolHttpServer(config, pool);
    poolServers.push(gateway);
    const gatewayPort = await listen(gateway.server);
    const origin = `http://127.0.0.1:${gatewayPort}`;
    const acquired = await fetch(`${origin}/leases`, {
      method: "POST",
      headers: { authorization: `Bearer ${config.bearerToken}` },
      body: JSON.stringify({ wait_ms: 0 }),
    });
    const lease = await acquired.json() as { token: string };
    const authorization = `Bearer ${lease.token}`;
    const started = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization },
      body: JSON.stringify({ method: "slice_start" }),
    });
    const job = await started.json() as { job_id: string };
    const interrupted = httpRequest(`${origin}/mcp`, {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
      },
    });
    interrupted.on("error", () => {});
    interrupted.end(JSON.stringify({
      method: "job_get",
      params: { job_id: job.job_id, interrupt: true },
    }));
    await interruptedRequest;
    interrupted.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const reconnected = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization },
      body: JSON.stringify({ method: "job_get", params: { job_id: job.job_id } }),
    });

    await expect(reconnected.json()).resolves.toEqual({ job_id: "slice-job-1", state: "succeeded" });
    expect(calls).toEqual([
      { authorization: "Bearer backend-worker-1", body: JSON.stringify({ method: "slice_start" }) },
      {
        authorization: "Bearer backend-worker-1",
        body: JSON.stringify({
          method: "job_get",
          params: { job_id: "slice-job-1", interrupt: true },
        }),
      },
      {
        authorization: "Bearer backend-worker-1",
        body: JSON.stringify({ method: "job_get", params: { job_id: "slice-job-1" } }),
      },
    ]);
  });

  it("exposes capacity, health, and Prometheus lifecycle metrics", async () => {
    const provisioner = new FlakyProvisioner();
    provisioner.provisionFailures = 1;
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 100,
      maxQueue: 1,
      retryDelayMs: 5,
    });
    pools.push(pool);
    await pool.start();
    await waitFor(() => pool.stats().ready === 1);
    const lease = await pool.acquire(0);
    await expect(pool.acquire(10)).rejects.toThrow("Timed out");
    await expect(pool.acquire(0)).rejects.toThrow("available");
    await waitFor(() => pool.leaseForToken(lease.token, false) === undefined);
    await waitFor(() => pool.stats().ready === 1);
    const config = poolConfig({ leaseTtlMs: 100 });
    const gateway = createAgentPoolHttpServer(config, pool);
    poolServers.push(gateway);
    const gatewayPort = await listen(gateway.server);
    const origin = `http://127.0.0.1:${gatewayPort}`;

    const capacity = await fetch(`${origin}/capacity`);
    expect(capacity.status).toBe(200);
    await expect(capacity.json()).resolves.toMatchObject({
      ok: true,
      acceptingLeases: expect.any(Boolean),
      retryAfterMs: expect.any(Number),
      pool: {
        target: 1,
        ready: expect.any(Number),
        leased: 0,
        starting: expect.any(Number),
        unhealthy: expect.any(Number),
        queued: 0,
      },
    });
    const health = await fetch(`${origin}/healthz`);
    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ ok: true });

    const metrics = await fetch(`${origin}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    const text = await metrics.text();
    expect(text).toMatch(/agent_slicer_pool_lease_wait\w*(?:\{[^}]*\})? [1-9]/);
    expect(text).toMatch(/agent_slicer_pool_allocation_failures_total(?:\{[^}]*\})? [1-9]/);
    expect(text).toMatch(/agent_slicer_pool_worker_startup_failures_total(?:\{[^}]*\})? [1-9]/);
    expect(text).toMatch(/agent_slicer_pool_worker_reclamations_total(?:\{[^}]*\})? [1-9]/);
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

    await provisioner.reclaim(worker);
    expect(calls).toContainEqual({
      method: "DELETE",
      path: "/containers/container-1?force=true&v=true",
      body: undefined,
    });
  });
});

describe("static worker provisioner", () => {
  it("claims configured workers without creating containers and reuses them after reclaim", async () => {
    const provisioner = new StaticWorkerProvisioner({
      workerUrls: [
        new URL("http://worker-1:8765"),
        new URL("http://worker-2:8765"),
        new URL("http://worker-3:8765"),
      ],
      bearerToken: "backend-token",
      checkReady: async () => true,
    });

    const workers = await Promise.all([
      provisioner.provision(),
      provisioner.provision(),
      provisioner.provision(),
    ]);
    expect(workers.map((worker) => worker.baseUrl.href)).toEqual([
      "http://worker-1:8765/",
      "http://worker-2:8765/",
      "http://worker-3:8765/",
    ]);
    await expect(provisioner.provision()).rejects.toThrow("No unclaimed static");
    await expect(provisioner.healthy(workers[0]!)).resolves.toBe(true);

    await provisioner.reclaim(workers[0]!);
    const reclaimed = await provisioner.provision();
    expect(reclaimed.id).toBe(workers[0]!.id);
    expect(reclaimed.bearerToken).toBe("backend-token");
  });

  it("returns a released fixed worker to the lease pool", async () => {
    const provisioner = new StaticWorkerProvisioner({
      workerUrls: [new URL("http://worker-1:8765")],
      bearerToken: "backend-token",
      checkReady: async () => true,
    });
    const pool = new WarmWorkerPool(provisioner, {
      size: 1,
      leaseTtlMs: 60_000,
      maxQueue: 1,
      retryDelayMs: 10,
    });
    pools.push(pool);
    await pool.start();

    const first = await pool.acquire(0);
    const nextLease = pool.acquire(1_000);
    await pool.release(first.token, first.leaseId);
    const second = await nextLease;

    expect(second.worker.id).toBe(first.worker.id);
    expect(pool.stats()).toMatchObject({ target: 1, ready: 0, leased: 1 });
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
  it("requires strong tokens and validates fixed worker origins", () => {
    expect(() => loadPoolConfig({ AGENT_SLICER_POOL_TOKEN: "short" })).toThrow(
      "at least 32 characters",
    );
    expect(() => loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_WORKER_TOKEN: "w".repeat(48),
      AGENT_SLICER_POOL_WORKERS: "worker-1:8765",
    })).toThrow("plain HTTP origins");
    expect(() => loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_WORKER_TOKEN: "w".repeat(48),
      AGENT_SLICER_POOL_WORKERS: "https://worker-1:8765",
    })).toThrow("plain HTTP origins");
    const config = loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_WORKER_TOKEN: "w".repeat(48),
      AGENT_SLICER_POOL_ID: "production-a",
      AGENT_SLICER_POOL_WORKERS:
        "http://worker-1:8765,http://worker-2:8765,http://worker-3:8765",
    });
    expect(config).toMatchObject({
      poolSize: 3,
      poolId: "production-a",
      workerToken: "w".repeat(48),
    });
    expect(config.workerUrls.map((url) => url.href)).toEqual([
      "http://worker-1:8765/",
      "http://worker-2:8765/",
      "http://worker-3:8765/",
    ]);
    expect(() => loadPoolConfig({
      AGENT_SLICER_POOL_TOKEN: "p".repeat(48),
      AGENT_SLICER_POOL_WORKER_TOKEN: "w".repeat(48),
      AGENT_SLICER_POOL_ID: "invalid pool id",
    })).toThrow("AGENT_SLICER_POOL_ID");
  });
});
