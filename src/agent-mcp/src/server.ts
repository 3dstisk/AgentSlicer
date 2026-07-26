import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import { hostHeaderValidation, originValidation, toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import type { AgentMcpConfig } from "./config.js";
import { registerAgentTools, type ToolDependencies } from "./tool-contract.js";

export function createAgentMcpServer(dependencies: ToolDependencies): McpServer {
  const server = new McpServer({
    name: "AgentSlicer",
    version: "0.1.0",
  });
  registerAgentTools(server, dependencies);
  return server;
}

export function createAgentMcpHandler(dependencies: ToolDependencies): McpHttpHandler {
  return createMcpHandler(() => createAgentMcpServer(dependencies), {
    legacy: "stateless",
    responseMode: "auto",
  });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

const HEALTH_SERVICE = "agent-slicer-mcp";
const HEALTH_TIMEOUT_MAX_MS = 5_000;

function isHealthPath(path: string): boolean {
  return path === "/livez" || path === "/readyz" || path === "/healthz";
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("health_check_timed_out")), timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function sendReadiness(
  response: ServerResponse,
  bridgeStatus: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  try {
    const status = await withTimeout(bridgeStatus, timeoutMs);
    const ready = typeof status === "object" &&
      status !== null &&
      "ready" in status &&
      status.ready === true;
    sendJson(
      response,
      ready ? 200 : 503,
      ready
        ? { ok: true, service: HEALTH_SERVICE, ready: true }
        : { ok: false, service: HEALTH_SERVICE, ready: false, reason: "not_ready" },
    );
  } catch {
    sendJson(response, 503, {
      ok: false,
      service: HEALTH_SERVICE,
      ready: false,
      reason: "bridge_unavailable",
    });
  }
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (token === undefined) {
    return true;
  }
  const authorization = request.headers.authorization;
  if (authorization === undefined || Array.isArray(authorization)) {
    return false;
  }
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  const actual = createHash("sha256").update(authorization).digest();
  return timingSafeEqual(actual, expected);
}

export interface AgentHttpServer {
  server: HttpServer;
  close(): Promise<void>;
}

export function createAgentHttpServer(
  config: AgentMcpConfig,
  dependencies: ToolDependencies,
): AgentHttpServer {
  const handler = createAgentMcpHandler(dependencies);
  const mcp = toNodeHandler(handler);
  const validateHost = hostHeaderValidation([...config.allowedHosts]);
  const validateOrigin = originValidation([...config.allowedOrigins]);
  let readinessCall: Promise<unknown> | undefined;
  const bridgeStatus = (): Promise<unknown> => {
    if (readinessCall === undefined) {
      const call = Promise.resolve().then(() => dependencies.bridge.call("slicer_status"));
      readinessCall = call;
      void call.finally(() => {
        if (readinessCall === call) {
          readinessCall = undefined;
        }
      }).catch(() => {});
    }
    return readinessCall;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (isHealthPath(path) && request.method !== "GET") {
        response.setHeader("allow", "GET");
        sendJson(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (path === "/livez") {
        sendJson(response, 200, { ok: true, service: HEALTH_SERVICE });
        return;
      }
      if (path === "/readyz" || path === "/healthz") {
        await sendReadiness(
          response,
          bridgeStatus(),
          Math.min(config.bridgeTimeoutMs, HEALTH_TIMEOUT_MAX_MS),
        );
        return;
      }
      if (path !== "/mcp") {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      if (!validateHost(request, response) || !validateOrigin(request, response)) {
        return;
      }
      if (!authorized(request, config.bearerToken)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      await mcp(request, response);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : "internal_server_error",
        });
      } else {
        response.end();
      }
    });
  });

  return {
    server,
    async close(): Promise<void> {
      await handler.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
