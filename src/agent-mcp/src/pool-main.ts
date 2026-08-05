import { DockerEngineClient, DockerWorkerProvisioner } from "./docker-engine.js";
import { loadPoolConfig } from "./pool-config.js";
import { WarmWorkerPool } from "./pool.js";
import { createAgentPoolHttpServer } from "./pool-server.js";

const config = loadPoolConfig();
const docker = new DockerEngineClient({
  socketPath: config.dockerSocketPath,
  apiVersion: config.dockerApiVersion,
});
const provisioner = new DockerWorkerProvisioner(docker, {
  image: config.workerImage,
  network: config.workerNetwork,
  mcpPort: config.workerMcpPort,
  readyTimeoutMs: config.workerReadyTimeoutMs,
  readyPollMs: config.workerReadyPollMs,
  shmBytes: config.workerShmBytes,
  timezone: config.timezone,
  workerEnvironment: config.workerEnvironment,
});
const pool = new WarmWorkerPool(provisioner, {
  size: config.poolSize,
  leaseTtlMs: config.leaseTtlMs,
  maxQueue: config.maxQueue,
  retryDelayMs: config.retryDelayMs,
});

await pool.start();
const http = createAgentPoolHttpServer(config, pool);
http.server.listen(config.port, config.bindHost, () => {
  process.stdout.write(`${JSON.stringify({
    level: "info",
    message: "AgentSlicer pool listening",
    host: config.bindHost,
    port: config.port,
    pool: pool.stats(),
  })}\n`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stdout.write(`${JSON.stringify({
    level: "info",
    message: "Shutting down AgentSlicer pool",
    signal,
  })}\n`);
  void http.close()
    .then(() => pool.close())
    .then(
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
