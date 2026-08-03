import { resolve } from "node:path";
import { isIP } from "node:net";

export interface AgentMcpConfig {
  bindHost: string;
  port: number;
  bridgeSocketPath: string;
  bridgeTimeoutMs: number;
  screenshotRoots: readonly string[];
  desktopCaptureExecutable: string;
  desktopScreenshotRoot: string;
  maxImageBytes: number;
  workspaceRoot: string;
  outputRoot: string;
  maxUploadBytes: number;
  uploadTtlMs: number;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  bearerToken?: string;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  if (normalized.toLowerCase() === "localhost" || normalized === "::1") {
    return true;
  }
  if (isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }
  return false;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function absolutePath(value: string, name: string): string {
  const path = resolve(value);
  if (path !== value) {
    throw new Error(`${name} must be an absolute normalized path`);
  }
  return path;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentMcpConfig {
  const screenshotRoots = (env.AGENT_SLICER_SCREENSHOT_ROOTS ?? "/screenshots/mcp")
    .split(":")
    .filter(Boolean)
    .map((path) => absolutePath(path, "AGENT_SLICER_SCREENSHOT_ROOTS"));

  if (screenshotRoots.length === 0) {
    throw new Error("At least one screenshot root is required");
  }

  const config: AgentMcpConfig = {
    bindHost: env.AGENT_SLICER_MCP_HOST ?? "127.0.0.1",
    port: positiveInteger(env.AGENT_SLICER_MCP_PORT, 8765, "AGENT_SLICER_MCP_PORT"),
    bridgeSocketPath: absolutePath(
      env.AGENT_SLICER_BRIDGE_SOCKET ?? "/run/agent-slicer/orca-agent.sock",
      "AGENT_SLICER_BRIDGE_SOCKET",
    ),
    bridgeTimeoutMs: positiveInteger(
      env.AGENT_SLICER_BRIDGE_TIMEOUT_MS,
      30_000,
      "AGENT_SLICER_BRIDGE_TIMEOUT_MS",
    ),
    screenshotRoots,
    desktopCaptureExecutable: absolutePath(
      env.AGENT_SLICER_CAPTURE_EXECUTABLE ?? "/usr/local/bin/capture-orca",
      "AGENT_SLICER_CAPTURE_EXECUTABLE",
    ),
    desktopScreenshotRoot: absolutePath(
      env.AGENT_SLICER_DESKTOP_SCREENSHOT_ROOT ?? "/screenshots",
      "AGENT_SLICER_DESKTOP_SCREENSHOT_ROOT",
    ),
    maxImageBytes: positiveInteger(
      env.AGENT_SLICER_MAX_IMAGE_BYTES,
      16 * 1024 * 1024,
      "AGENT_SLICER_MAX_IMAGE_BYTES",
    ),
    workspaceRoot: "/workspace",
    outputRoot: "/outputs",
    maxUploadBytes: positiveInteger(
      env.AGENT_SLICER_MAX_UPLOAD_BYTES ?? env.AGENT_SLICER_MAX_IMPORT_BYTES,
      512 * 1024 * 1024,
      "AGENT_SLICER_MAX_UPLOAD_BYTES",
    ),
    uploadTtlMs: positiveInteger(
      env.AGENT_SLICER_UPLOAD_TTL_MS,
      15 * 60 * 1000,
      "AGENT_SLICER_UPLOAD_TTL_MS",
    ),
    allowedHosts: (env.AGENT_SLICER_ALLOWED_HOSTS ?? "localhost,127.0.0.1,[::1]")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
    allowedOrigins: (env.AGENT_SLICER_ALLOWED_ORIGINS ?? "localhost,127.0.0.1,[::1]")
      .split(",")
      .map((host) => host.trim())
      .filter(Boolean),
    ...(env.AGENT_SLICER_TOKEN ? { bearerToken: env.AGENT_SLICER_TOKEN } : {}),
  };

  if (config.port > 65_535) {
    throw new Error("AGENT_SLICER_MCP_PORT must be at most 65535");
  }
  if (config.uploadTtlMs > 24 * 60 * 60 * 1000) {
    throw new Error("AGENT_SLICER_UPLOAD_TTL_MS must be at most 86400000");
  }
  if (config.allowedHosts.length === 0 || config.allowedOrigins.length === 0) {
    throw new Error("Host and Origin allowlists must not be empty");
  }
  if (!isLoopbackHost(config.bindHost) && config.bearerToken === undefined) {
    throw new Error("AGENT_SLICER_TOKEN is required when binding MCP outside loopback");
  }
  return config;
}
