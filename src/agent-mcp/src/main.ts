import { BridgeClient } from "./bridge-client.js";
import { loadConfig } from "./config.js";
import { ExecutableDesktopCapture } from "./desktop-capture.js";
import { createAgentHttpServer } from "./server.js";

const config = loadConfig();
const bridge = new BridgeClient({
  socketPath: config.bridgeSocketPath,
  timeoutMs: config.bridgeTimeoutMs,
});
const desktopCapture = new ExecutableDesktopCapture(
  config.desktopCaptureExecutable,
  config.desktopScreenshotRoot,
  config.maxImageBytes,
);
const http = createAgentHttpServer(config, {
  bridge,
  desktopCapture,
  screenshotRoots: config.screenshotRoots,
  desktopScreenshotRoot: config.desktopScreenshotRoot,
  maxImageBytes: config.maxImageBytes,
});

http.server.listen(config.port, config.bindHost, () => {
  process.stdout.write(
    `${JSON.stringify({
      level: "info",
      message: "AgentSlicer MCP listening",
      host: config.bindHost,
      port: config.port,
    })}\n`,
  );
});

function shutdown(signal: string): void {
  process.stdout.write(`${JSON.stringify({ level: "info", message: "Shutting down", signal })}\n`);
  void http.close().then(
    () => {
      process.exitCode = 0;
    },
    () => {
      process.exitCode = 1;
    },
  );
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
