import { loadPoolConfig } from "./pool-config.js";
import { WarmWorkerPool } from "./pool.js";
import { createAgentPoolHttpServer } from "./pool-server.js";
import { StaticWorkerProvisioner } from "./static-workers.js";

const config = loadPoolConfig();
const provisioner = new StaticWorkerProvisioner({
  workerUrls: config.workerUrls,
  bearerToken: config.workerToken,
});
const pool = new WarmWorkerPool(provisioner, {
  size: config.poolSize,
  leaseTtlMs: config.leaseTtlMs,
  maxQueue: config.maxQueue,
  retryDelayMs: config.retryDelayMs,
  log: (event) => process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    ...event,
  })}\n`),
});

await pool.start();
const http = createAgentPoolHttpServer(config, pool);
http.server.listen(config.port, config.bindHost, () => {
  process.stdout.write(`${JSON.stringify({
    level: "info",
    message: "AgentSlicer pool listening",
    host: config.bindHost,
    port: config.port,
    pool_id: config.poolId,
    configured_workers: config.workerUrls.length,
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
