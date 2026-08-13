import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as upstreamRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";

import type { AgentPoolConfig } from "./pool-config.js";
import {
  PoolClosedError,
  PoolQueueFullError,
  PoolUnavailableError,
  type WarmWorkerPool,
} from "./pool.js";

const MAX_LEASE_REQUEST_BYTES = 4096;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function safePoolStats(pool: WarmWorkerPool): {
  target: number;
  ready: number;
  leased: number;
  starting: number;
  unhealthy: number;
  warming: number;
  queued: number;
} {
  const stats = pool.stats();
  return {
    target: stats.target,
    ready: stats.ready,
    leased: stats.leased,
    starting: stats.starting,
    unhealthy: stats.unhealthy,
    warming: stats.warming,
    queued: stats.queued,
  };
}

function retryAfter(pool: WarmWorkerPool): { milliseconds: number; seconds: number } {
  const milliseconds = pool.retryAfterMs();
  return { milliseconds, seconds: Math.max(1, Math.ceil(milliseconds / 1_000)) };
}

function sendCapacityError(
  response: ServerResponse,
  status: number,
  pool: WarmWorkerPool,
  code: string,
  message: string,
): void {
  const retry = retryAfter(pool);
  response.setHeader("retry-after", String(retry.seconds));
  sendJson(response, status, {
    error: { code, message },
    retryable: true,
    retryAfterMs: retry.milliseconds,
    pool: safePoolStats(pool),
  });
}

function metricLabels(name: string, values: Readonly<Record<string, number>>): string {
  return Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, value]) => `${name}{reason=${JSON.stringify(reason)}} ${value}`)
    .join("\n");
}

function prometheusMetrics(pool: WarmWorkerPool): string {
  const stats = safePoolStats(pool);
  const metrics = pool.metrics();
  const allocationFailures = {
    capacity_unavailable: 0,
    client_abandoned: 0,
    pool_closed: 0,
    queue_full: 0,
    ...metrics.allocationFailures,
  };
  const reclamations = {
    expired: 0,
    invalidated: 0,
    released: 0,
    startup_readiness_failed: 0,
    unhealthy_before_allocation: 0,
    ...metrics.workerReclamations,
  };
  const lines = [
    "# HELP agent_slicer_pool_workers Current workers by lifecycle state.",
    "# TYPE agent_slicer_pool_workers gauge",
    `agent_slicer_pool_workers{state="ready"} ${stats.ready}`,
    `agent_slicer_pool_workers{state="leased"} ${stats.leased}`,
    `agent_slicer_pool_workers{state="starting"} ${stats.starting}`,
    `agent_slicer_pool_workers{state="unhealthy"} ${stats.unhealthy}`,
    "# HELP agent_slicer_pool_lease_wait_duration_seconds Time spent acquiring a worker lease.",
    "# TYPE agent_slicer_pool_lease_wait_duration_seconds histogram",
    ...metrics.leaseWait.buckets.map(({ upperBoundMs, count }) =>
      `agent_slicer_pool_lease_wait_duration_seconds_bucket{le="${upperBoundMs / 1_000}"} ${count}`
    ),
    `agent_slicer_pool_lease_wait_duration_seconds_bucket{le="+Inf"} ${metrics.leaseWait.count}`,
    `agent_slicer_pool_lease_wait_duration_seconds_sum ${metrics.leaseWait.sumMs / 1_000}`,
    `agent_slicer_pool_lease_wait_duration_seconds_count ${metrics.leaseWait.count}`,
    "# HELP agent_slicer_pool_allocation_failures_total Failed worker lease allocations.",
    "# TYPE agent_slicer_pool_allocation_failures_total counter",
    metricLabels("agent_slicer_pool_allocation_failures_total", allocationFailures),
    "# HELP agent_slicer_pool_worker_startup_failures_total Workers that failed provisioning or final readiness.",
    "# TYPE agent_slicer_pool_worker_startup_failures_total counter",
    `agent_slicer_pool_worker_startup_failures_total ${metrics.workerStartupFailures}`,
    "# HELP agent_slicer_pool_worker_reclamations_total Workers destroyed after lease or health lifecycle events.",
    "# TYPE agent_slicer_pool_worker_reclamations_total counter",
    metricLabels("agent_slicer_pool_worker_reclamations_total", reclamations),
    "# HELP agent_slicer_pool_worker_reclamation_failures_total Failed worker destruction attempts.",
    "# TYPE agent_slicer_pool_worker_reclamation_failures_total counter",
    `agent_slicer_pool_worker_reclamation_failures_total ${metrics.workerReclamationFailures}`,
  ];
  return `${lines.filter((line) => line.length > 0).join("\n")}\n`;
}

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
    return undefined;
  }
  const token = authorization.slice("Bearer ".length);
  return token.length > 0 ? token : undefined;
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualHash = createHash("sha256").update(actual).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_LEASE_REQUEST_BYTES) {
      throw new Error("lease_request_too_large");
    }
    chunks.push(buffer);
  }
  if (bytes === 0) {
    return {};
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("lease_request_must_be_an_object");
  }
  return parsed as Record<string, unknown>;
}

function proxyHeaders(headers: IncomingHttpHeaders, backendToken: string): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name) &&
        name !== "authorization" && name !== "host" && name !== "origin") {
      result[name] = value;
    }
  }
  result.authorization = `Bearer ${backendToken}`;
  result.host = "localhost";
  return result;
}

function responseHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name)) {
      result[name] = value;
    }
  }
  result["cache-control"] = "no-store";
  return result;
}

function isProxyPath(path: string): boolean {
  return path === "/mcp" || path === "/outputs" || path === "/outputs/" ||
    path.startsWith("/outputs/") || path.startsWith("/uploads/");
}

async function proxyToWorker(
  request: IncomingMessage,
  response: ServerResponse,
  pool: WarmWorkerPool,
  leaseToken: string,
): Promise<void> {
  const lease = pool.leaseForToken(leaseToken);
  if (lease === undefined) {
    sendJson(response, 401, { error: "invalid_or_expired_lease" });
    return;
  }
  const incomingUrl = new URL(request.url ?? "/", "http://localhost");
  const target = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, lease.worker.baseUrl);
  await new Promise<void>((resolve) => {
    let receivedResponse = false;
    let downstreamAborted = false;
    const upstream = upstreamRequest(target, {
      method: request.method,
      headers: proxyHeaders(request.headers, lease.worker.bearerToken),
    });
    upstream.once("response", (upstreamResponse) => {
      receivedResponse = true;
      response.writeHead(
        upstreamResponse.statusCode ?? 502,
        responseHeaders(upstreamResponse.headers),
      );
      upstreamResponse.once("error", () => {
        response.destroy();
        if (!downstreamAborted) {
          void pool.invalidate(leaseToken);
        }
        resolve();
      });
      upstreamResponse.once("end", resolve);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (downstreamAborted) {
        resolve();
        return;
      }
      if (!receivedResponse && !response.headersSent) {
        sendJson(response, 502, { error: "worker_unavailable" });
      } else {
        response.destroy();
      }
      void pool.invalidate(leaseToken);
      resolve();
    });
    request.once("aborted", () => {
      downstreamAborted = true;
      upstream.destroy();
    });
    response.once("close", () => {
      if (!response.writableEnded) {
        downstreamAborted = true;
        upstream.destroy();
      }
    });
    request.pipe(upstream);
  });
}

export interface AgentPoolHttpServer {
  server: HttpServer;
  close(): Promise<void>;
}

export function createAgentPoolHttpServer(
  config: AgentPoolConfig,
  pool: WarmWorkerPool,
): AgentPoolHttpServer {
  const validateHost = hostHeaderValidation([...config.allowedHosts]);
  const validateOrigin = originValidation([...config.allowedOrigins]);
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/livez") {
        sendJson(response, 200, { ok: true, service: "agent-slicer-pool" });
        return;
      }
      if (path === "/capacity") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        const poolStats = safePoolStats(pool);
        sendJson(response, 200, {
          ok: true,
          acceptingLeases: poolStats.ready > 0,
          retryAfterMs: pool.retryAfterMs(),
          pool: poolStats,
        });
        return;
      }
      if (path === "/metrics") {
        if (request.method !== "GET") {
          response.setHeader("allow", "GET");
          sendJson(response, 405, { error: "method_not_allowed" });
          return;
        }
        response.writeHead(200, {
          "cache-control": "no-store",
          "content-type": "text/plain; version=0.0.4; charset=utf-8",
          "x-content-type-options": "nosniff",
        });
        response.end(prometheusMetrics(pool));
        return;
      }
      if (path === "/readyz" || path === "/healthz") {
        const stats = safePoolStats(pool);
        const ready = stats.ready + stats.leased > 0;
        sendJson(response, ready ? 200 : 503, {
          ok: ready,
          service: "agent-slicer-pool",
          accepting_leases: stats.ready > 0,
          pool: stats,
        });
        return;
      }
      if (!validateHost(request, response) || !validateOrigin(request, response)) {
        return;
      }

      if (path === "/leases" && request.method === "POST") {
        if (!tokenMatches(bearerToken(request), config.bearerToken)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        let body: Record<string, unknown>;
        try {
          body = await jsonBody(request);
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "invalid_lease_request",
          });
          return;
        }
        if (Object.keys(body).some((key) => key !== "wait_ms")) {
          sendJson(response, 400, { error: "unknown_lease_request_field" });
          return;
        }
        const requestedWait = body.wait_ms ?? config.acquireWaitMs;
        if (!Number.isSafeInteger(requestedWait) ||
            (requestedWait as number) < 0 ||
            (requestedWait as number) > config.acquireWaitMs) {
          sendJson(response, 400, { error: "invalid_wait_ms" });
          return;
        }
        try {
          const abandoned = new AbortController();
          response.once("close", () => {
            if (!response.writableEnded) {
              abandoned.abort();
            }
          });
          const lease = await pool.acquire(requestedWait as number, abandoned.signal);
          if (abandoned.signal.aborted || response.destroyed) {
            await pool.release(lease.token, lease.leaseId);
            return;
          }
          sendJson(response, 201, {
            lease_id: lease.leaseId,
            token: lease.token,
            expires_at: lease.expiresAt.toISOString(),
            mcp_path: "/mcp",
            release_path: `/leases/${lease.leaseId}`,
            required_headers: {
              authorization: `Bearer ${lease.token}`,
            },
            heartbeat_path: `/leases/${lease.leaseId}`,
          });
        } catch (error) {
          if (error instanceof PoolQueueFullError) {
            sendCapacityError(
              response,
              429,
              pool,
              "lease_queue_full",
              "The AgentSlicer lease queue is full",
            );
          } else if (error instanceof PoolUnavailableError) {
            sendCapacityError(
              response,
              503,
              pool,
              "capacity_unavailable",
              "No healthy AgentSlicer worker became available before the lease wait expired",
            );
          } else if (error instanceof PoolClosedError) {
            sendCapacityError(
              response,
              503,
              pool,
              "pool_shutting_down",
              "The AgentSlicer pool is shutting down",
            );
          } else {
            throw error;
          }
        }
        return;
      }

      const releaseMatch = /^\/leases\/([0-9a-f-]+)$/.exec(path);
      if (releaseMatch !== null && request.method === "PATCH") {
        const token = bearerToken(request);
        const leaseId = releaseMatch[1]!;
        const lease = token === undefined ? undefined : pool.renew(token, leaseId);
        if (lease === undefined) {
          sendJson(response, 401, { error: "invalid_or_expired_lease" });
          return;
        }
        sendJson(response, 200, {
          lease_id: lease.leaseId,
          expires_at: lease.expiresAt.toISOString(),
          renewed: true,
        });
        return;
      }
      if (releaseMatch !== null && request.method === "DELETE") {
        const token = bearerToken(request);
        if (token === undefined || !await pool.release(token, releaseMatch[1])) {
          sendJson(response, 401, { error: "invalid_or_expired_lease" });
          return;
        }
        sendJson(response, 202, { released: true, replacement_warming: true });
        return;
      }

      if (!isProxyPath(path)) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const token = bearerToken(request);
      if (token === undefined) {
        sendJson(response, 401, { error: "invalid_or_expired_lease" });
        return;
      }
      await proxyToWorker(request, response, pool, token);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "internal_server_error",
        });
      } else {
        response.destroy();
      }
    });
  });

  return {
    server,
    async close(): Promise<void> {
      if (!server.listening) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
