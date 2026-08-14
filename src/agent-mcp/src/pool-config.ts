import { isIP } from "node:net";

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
  workerUrls: readonly URL[];
  workerToken: string;
}

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

function csv(value: string, name: string): string[] {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return entries;
}

function workerUrls(value: string | undefined): URL[] {
  const entries = csv(
    value ?? "http://agent-slicer-worker-1:8765,http://agent-slicer-worker-2:8765,http://agent-slicer-worker-3:8765",
    "AGENT_SLICER_POOL_WORKERS",
  );
  const urls = entries.map((entry) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error("AGENT_SLICER_POOL_WORKERS must contain comma-delimited absolute URLs");
    }
    if (url.protocol !== "http:" || url.username !== "" || url.password !== "" ||
        url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      throw new Error("AGENT_SLICER_POOL_WORKERS URLs must be plain HTTP origins");
    }
    return url;
  });
  if (urls.length > 100) {
    throw new Error("AGENT_SLICER_POOL_WORKERS must contain at most 100 URLs");
  }
  if (new Set(urls.map((url) => url.href)).size !== urls.length) {
    throw new Error("AGENT_SLICER_POOL_WORKERS must not contain duplicate URLs");
  }
  return urls;
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
  const configuredWorkerUrls = workerUrls(env.AGENT_SLICER_POOL_WORKERS);
  const workerToken = env.AGENT_SLICER_POOL_WORKER_TOKEN;
  if (workerToken === undefined || workerToken.length < 32) {
    throw new Error("AGENT_SLICER_POOL_WORKER_TOKEN must contain at least 32 characters");
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
    poolSize: configuredWorkerUrls.length,
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
    workerUrls: configuredWorkerUrls,
    workerToken,
  };
}
