import { isIP } from "node:net";
import { resolve } from "node:path";

export interface AgentPoolConfig {
  bindHost: string;
  port: number;
  bearerToken: string;
  poolId: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  poolSize: number;
  maxQueue: number;
  acquireWaitMs: number;
  leaseTtlMs: number;
  retryDelayMs: number;
  dockerSocketPath: string;
  dockerApiVersion?: string;
  workerImage: string;
  workerNetwork: string;
  workerMcpPort: number;
  workerReadyTimeoutMs: number;
  workerReadyPollMs: number;
  workerShmBytes: number;
  workerEnvironment: readonly string[];
  timezone: string;
}

const RESERVED_WORKER_ENVIRONMENT = new Set([
  "PUID",
  "PGID",
  "TZ",
  "AGENT_SLICER_MCP_HOST",
  "AGENT_SLICER_MCP_PORT",
  "AGENT_SLICER_TOKEN",
  "AGENT_SLICER_ALLOWED_HOSTS",
  "AGENT_SLICER_ALLOWED_ORIGINS",
  "HARDEN_DESKTOP",
  "START_DOCKER",
  "SELKIES_FILE_TRANSFERS",
  "SELKIES_COMMAND_ENABLED",
  "SELKIES_ENABLE_SHARING",
]);

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function absolutePath(value: string, name: string): string {
  const normalized = resolve(value);
  if (normalized !== value) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return normalized;
}

function csv(value: string, name: string): string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return entries;
}

function dockerApiVersion(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    return undefined;
  }
  if (!/^\d+\.\d+$/.test(normalized)) {
    throw new Error("AGENT_SLICER_POOL_DOCKER_API_VERSION must use major.minor format");
  }
  return normalized;
}

function isLoopback(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  return normalized.toLowerCase() === "localhost" || normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.startsWith("127."));
}

export function loadPoolConfig(env: NodeJS.ProcessEnv = process.env): AgentPoolConfig {
  const bindHost = env.AGENT_SLICER_POOL_HOST ?? "127.0.0.1";
  const bearerToken = env.AGENT_SLICER_POOL_TOKEN;
  if (bearerToken === undefined || bearerToken.length < 32) {
    throw new Error("AGENT_SLICER_POOL_TOKEN must contain at least 32 characters");
  }
  if (!isLoopback(bindHost) && bearerToken.length < 48) {
    throw new Error("AGENT_SLICER_POOL_TOKEN must contain at least 48 characters outside loopback");
  }
  const poolId = env.AGENT_SLICER_POOL_ID ?? "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(poolId)) {
    throw new Error(
      "AGENT_SLICER_POOL_ID must be 1-63 letters, digits, dots, underscores, or hyphens",
    );
  }
  const workerEnvironment = (env.AGENT_SLICER_POOL_WORKER_ENV ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (workerEnvironment.some((entry) => !/^[A-Z_][A-Z0-9_]*=/.test(entry))) {
    throw new Error("AGENT_SLICER_POOL_WORKER_ENV must contain newline-delimited NAME=value entries");
  }
  if (workerEnvironment.some((entry) =>
    RESERVED_WORKER_ENVIRONMENT.has(entry.slice(0, entry.indexOf("="))))) {
    throw new Error("AGENT_SLICER_POOL_WORKER_ENV must not override pool-managed settings");
  }

  return {
    bindHost,
    port: integer(env.AGENT_SLICER_POOL_PORT, 8765, "AGENT_SLICER_POOL_PORT", 1, 65_535),
    bearerToken,
    poolId,
    allowedHosts: csv(
      env.AGENT_SLICER_POOL_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]",
      "AGENT_SLICER_POOL_ALLOWED_HOSTS",
    ),
    allowedOrigins: csv(
      env.AGENT_SLICER_POOL_ALLOWED_ORIGINS ?? "localhost,127.0.0.1,[::1]",
      "AGENT_SLICER_POOL_ALLOWED_ORIGINS",
    ),
    poolSize: integer(env.AGENT_SLICER_POOL_SIZE, 2, "AGENT_SLICER_POOL_SIZE", 1, 100),
    maxQueue: integer(env.AGENT_SLICER_POOL_MAX_QUEUE, 100, "AGENT_SLICER_POOL_MAX_QUEUE", 0, 10_000),
    acquireWaitMs: integer(
      env.AGENT_SLICER_POOL_ACQUIRE_WAIT_MS,
      60_000,
      "AGENT_SLICER_POOL_ACQUIRE_WAIT_MS",
      0,
      5 * 60_000,
    ),
    leaseTtlMs: integer(
      env.AGENT_SLICER_POOL_LEASE_TTL_MS,
      30 * 60_000,
      "AGENT_SLICER_POOL_LEASE_TTL_MS",
      60_000,
      24 * 60 * 60_000,
    ),
    retryDelayMs: integer(
      env.AGENT_SLICER_POOL_RETRY_DELAY_MS,
      5_000,
      "AGENT_SLICER_POOL_RETRY_DELAY_MS",
      100,
      60_000,
    ),
    dockerSocketPath: absolutePath(
      env.AGENT_SLICER_POOL_DOCKER_SOCKET ?? "/var/run/docker.sock",
      "AGENT_SLICER_POOL_DOCKER_SOCKET",
    ),
    dockerApiVersion: dockerApiVersion(env.AGENT_SLICER_POOL_DOCKER_API_VERSION),
    workerImage: env.AGENT_SLICER_POOL_WORKER_IMAGE ?? "ghcr.io/3dstisk/agentslicer:latest",
    workerNetwork: env.AGENT_SLICER_POOL_NETWORK ?? "agent-slicer-pool",
    workerMcpPort: integer(
      env.AGENT_SLICER_POOL_WORKER_MCP_PORT,
      8765,
      "AGENT_SLICER_POOL_WORKER_MCP_PORT",
      1,
      65_535,
    ),
    workerReadyTimeoutMs: integer(
      env.AGENT_SLICER_POOL_WORKER_READY_TIMEOUT_MS,
      180_000,
      "AGENT_SLICER_POOL_WORKER_READY_TIMEOUT_MS",
      1_000,
      15 * 60_000,
    ),
    workerReadyPollMs: integer(
      env.AGENT_SLICER_POOL_WORKER_READY_POLL_MS,
      1_000,
      "AGENT_SLICER_POOL_WORKER_READY_POLL_MS",
      100,
      30_000,
    ),
    workerShmBytes: integer(
      env.AGENT_SLICER_POOL_WORKER_SHM_BYTES,
      1024 * 1024 * 1024,
      "AGENT_SLICER_POOL_WORKER_SHM_BYTES",
      64 * 1024 * 1024,
      16 * 1024 * 1024 * 1024,
    ),
    workerEnvironment,
    timezone: env.TZ ?? "UTC",
  };
}
