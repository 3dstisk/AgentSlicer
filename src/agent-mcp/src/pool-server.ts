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
        void pool.invalidate(leaseToken);
        resolve();
      });
      upstreamResponse.once("end", resolve);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (!receivedResponse && !response.headersSent) {
        sendJson(response, 502, { error: "worker_unavailable" });
      } else {
        response.destroy();
      }
      void pool.invalidate(leaseToken);
      resolve();
    });
    request.once("aborted", () => upstream.destroy());
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
      if (path === "/readyz" || path === "/healthz") {
        const stats = pool.stats();
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
          sendJson(response, 201, {
            lease_id: lease.leaseId,
            token: lease.token,
            expires_at: lease.expiresAt.toISOString(),
            mcp_path: "/mcp",
            release_path: `/leases/${lease.leaseId}`,
            required_headers: {
              authorization: `Bearer ${lease.token}`,
            },
          });
        } catch (error) {
          if (error instanceof PoolQueueFullError) {
            response.setHeader("retry-after", "5");
            sendJson(response, 429, { error: "lease_queue_full", pool: pool.stats() });
          } else if (error instanceof PoolUnavailableError) {
            response.setHeader("retry-after", "5");
            sendJson(response, 503, { error: "no_worker_available", pool: pool.stats() });
          } else if (error instanceof PoolClosedError) {
            sendJson(response, 503, { error: "pool_shutting_down" });
          } else {
            throw error;
          }
        }
        return;
      }

      const releaseMatch = /^\/leases\/([0-9a-f-]+)$/.exec(path);
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
