import type { PoolWorker, WorkerProvisioner } from "./pool.js";

export interface StaticWorkerProvisionerOptions {
  workerUrls: readonly URL[];
  bearerToken: string;
  checkReady?: (baseUrl: URL) => Promise<boolean>;
}

async function defaultReadyCheck(baseUrl: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL("/readyz", baseUrl), {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Supplies workers from a fixed set of container service URLs.
 *
 * The warm pool claims every configured worker at startup. Reclaiming a worker
 * makes that same service available to the pool again; it never creates,
 * removes, or restarts containers.
 */
export class StaticWorkerProvisioner implements WorkerProvisioner {
  private readonly workers = new Map<string, PoolWorker>();
  private readonly available: PoolWorker[];
  private readonly claimed = new Set<string>();

  constructor(private readonly options: StaticWorkerProvisionerOptions) {
    this.available = options.workerUrls.map((baseUrl) => {
      const id = baseUrl.href;
      const worker = {
        id,
        baseUrl: new URL(baseUrl),
        bearerToken: options.bearerToken,
      };
      this.workers.set(id, worker);
      return worker;
    });
  }

  async provision(): Promise<PoolWorker> {
    const worker = this.available.shift();
    if (worker === undefined) {
      throw new Error("No unclaimed static AgentSlicer worker is available");
    }
    this.claimed.add(worker.id);
    return worker;
  }

  async reclaim(worker: PoolWorker): Promise<void> {
    if (!this.claimed.delete(worker.id)) {
      return;
    }
    const configured = this.workers.get(worker.id);
    if (configured === undefined) {
      throw new Error(`Unknown static AgentSlicer worker: ${worker.id}`);
    }
    this.available.push(configured);
  }

  async healthy(worker: PoolWorker): Promise<boolean> {
    const check = this.options.checkReady ?? defaultReadyCheck;
    return check(worker.baseUrl);
  }
}
