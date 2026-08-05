import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface PoolWorker {
  id: string;
  baseUrl: URL;
  bearerToken: string;
}

export interface WorkerProvisioner {
  provision(): Promise<PoolWorker>;
  destroy(worker: PoolWorker): Promise<void>;
}

export interface WorkerLease {
  leaseId: string;
  token: string;
  expiresAt: Date;
  worker: PoolWorker;
}

export interface WarmPoolOptions {
  size: number;
  leaseTtlMs: number;
  maxQueue: number;
  retryDelayMs?: number;
  now?: () => number;
}

export interface PoolStats {
  target: number;
  ready: number;
  leased: number;
  warming: number;
  queued: number;
}

interface LeaseRecord {
  leaseId: string;
  tokenHash: string;
  expiresAt: number;
  worker: PoolWorker;
  timer?: NodeJS.Timeout;
}

interface Waiter {
  resolve: (lease: WorkerLease) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
}

export class PoolUnavailableError extends Error {
  constructor(message = "No warm AgentSlicer worker is available") {
    super(message);
    this.name = "PoolUnavailableError";
  }
}

export class PoolQueueFullError extends Error {
  constructor() {
    super("The AgentSlicer lease queue is full");
    this.name = "PoolQueueFullError";
  }
}

export class PoolClosedError extends Error {
  constructor() {
    super("The AgentSlicer pool is shutting down");
    this.name = "PoolClosedError";
  }
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class WarmWorkerPool {
  private readonly ready: PoolWorker[] = [];
  private readonly leasesByToken = new Map<string, LeaseRecord>();
  private readonly leasesById = new Map<string, LeaseRecord>();
  private readonly waiters: Waiter[] = [];
  private readonly workers = new Map<string, PoolWorker>();
  private readonly warmOperations = new Set<Promise<void>>();
  private warming = 0;
  private retryTimer: NodeJS.Timeout | undefined;
  private started = false;
  private closed = false;

  constructor(
    private readonly provisioner: WorkerProvisioner,
    private readonly options: WarmPoolOptions,
  ) {
    if (!Number.isSafeInteger(options.size) || options.size <= 0) {
      throw new Error("Pool size must be a positive integer");
    }
    if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
      throw new Error("Lease TTL must be a positive integer");
    }
    if (!Number.isSafeInteger(options.maxQueue) || options.maxQueue < 0) {
      throw new Error("Pool queue size must be a non-negative integer");
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    await this.ensureCapacity(true);
  }

  stats(): PoolStats {
    return {
      target: this.options.size,
      ready: this.ready.length,
      leased: this.leasesById.size,
      warming: this.warming,
      queued: this.waiters.length,
    };
  }

  acquire(waitMs: number, signal?: AbortSignal): Promise<WorkerLease> {
    if (this.closed) {
      return Promise.reject(new PoolClosedError());
    }
    if (signal?.aborted) {
      return Promise.reject(new PoolUnavailableError("Lease request was abandoned"));
    }
    const worker = this.ready.shift();
    if (worker !== undefined) {
      return Promise.resolve(this.createLease(worker));
    }
    if (waitMs <= 0) {
      return Promise.reject(new PoolUnavailableError());
    }
    if (this.waiters.length >= this.options.maxQueue) {
      return Promise.reject(new PoolQueueFullError());
    }
    return new Promise<WorkerLease>((resolve, reject) => {
      const remove = (): void => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
        }
      };
      const abort = (): void => {
        remove();
        waiter.cleanup();
        reject(new PoolUnavailableError("Lease request was abandoned"));
      };
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          remove();
          waiter.cleanup();
          reject(new PoolUnavailableError("Timed out waiting for a warm AgentSlicer worker"));
        }, waitMs),
        cleanup: () => {
          clearTimeout(waiter.timer);
          signal?.removeEventListener("abort", abort);
        },
      };
      waiter.timer.unref();
      signal?.addEventListener("abort", abort, { once: true });
      this.waiters.push(waiter);
    });
  }

  leaseForToken(token: string, refresh = true): WorkerLease | undefined {
    const record = this.leasesByToken.get(tokenHash(token));
    if (record === undefined || record.expiresAt <= this.now()) {
      if (record !== undefined) {
        void this.releaseRecord(record);
      }
      return undefined;
    }
    if (refresh) {
      this.refreshRecord(record);
    }
    return this.publicLease(record, token);
  }

  async release(token: string, leaseId?: string): Promise<boolean> {
    const record = this.leasesByToken.get(tokenHash(token));
    if (record === undefined || (leaseId !== undefined && record.leaseId !== leaseId)) {
      return false;
    }
    await this.releaseRecord(record);
    return true;
  }

  async invalidate(token: string): Promise<void> {
    const record = this.leasesByToken.get(tokenHash(token));
    if (record !== undefined) {
      await this.releaseRecord(record);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.cleanup();
      waiter.reject(new PoolClosedError());
    }
    for (const record of this.leasesById.values()) {
      if (record.timer !== undefined) {
        clearTimeout(record.timer);
      }
    }
    this.leasesById.clear();
    this.leasesByToken.clear();
    this.ready.length = 0;
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled([
      ...workers.map((worker) => this.provisioner.destroy(worker)),
      ...this.warmOperations,
    ]);
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private createLease(worker: PoolWorker): WorkerLease {
    const token = randomBytes(32).toString("base64url");
    const leaseId = randomUUID();
    const record: LeaseRecord = {
      leaseId,
      tokenHash: tokenHash(token),
      expiresAt: this.now() + this.options.leaseTtlMs,
      worker,
    };
    record.timer = this.expiryTimer(record);
    this.leasesByToken.set(record.tokenHash, record);
    this.leasesById.set(record.leaseId, record);
    return this.publicLease(record, token);
  }

  private publicLease(record: LeaseRecord, token: string): WorkerLease {
    return {
      leaseId: record.leaseId,
      token,
      expiresAt: new Date(record.expiresAt),
      worker: record.worker,
    };
  }

  private refreshRecord(record: LeaseRecord): void {
    record.expiresAt = this.now() + this.options.leaseTtlMs;
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
    }
    record.timer = this.expiryTimer(record);
  }

  private expiryTimer(record: LeaseRecord): NodeJS.Timeout {
    const timer = setTimeout(() => void this.releaseRecord(record), this.options.leaseTtlMs);
    timer.unref();
    return timer;
  }

  private async releaseRecord(record: LeaseRecord): Promise<void> {
    if (this.leasesById.get(record.leaseId) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
    }
    this.leasesById.delete(record.leaseId);
    this.leasesByToken.delete(record.tokenHash);
    this.workers.delete(record.worker.id);
    await Promise.allSettled([this.provisioner.destroy(record.worker)]);
    void this.ensureCapacity(false);
  }

  private async ensureCapacity(awaitInitial: boolean): Promise<void> {
    if (this.closed) {
      return;
    }
    const missing = this.options.size - this.workers.size - this.warming;
    if (missing <= 0) {
      return;
    }
    const operations = Array.from({ length: missing }, () => this.launchWarm());
    if (awaitInitial) {
      await Promise.allSettled(operations);
    }
  }

  private launchWarm(): Promise<void> {
    const operation = this.warmOne();
    this.warmOperations.add(operation);
    void operation.finally(() => this.warmOperations.delete(operation));
    return operation;
  }

  private async warmOne(): Promise<void> {
    ++this.warming;
    try {
      const worker = await this.provisioner.provision();
      if (this.closed) {
        await this.provisioner.destroy(worker);
        return;
      }
      if (this.workers.has(worker.id)) {
        await this.provisioner.destroy(worker);
        throw new Error(`Provisioner returned duplicate worker id: ${worker.id}`);
      }
      this.workers.set(worker.id, worker);
      const waiter = this.waiters.shift();
      if (waiter === undefined) {
        this.ready.push(worker);
      } else {
        clearTimeout(waiter.timer);
        waiter.cleanup();
        waiter.resolve(this.createLease(worker));
      }
    } catch {
      this.scheduleRetry();
    } finally {
      --this.warming;
    }
  }

  private scheduleRetry(): void {
    if (this.closed || this.retryTimer !== undefined) {
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.ensureCapacity(false);
    }, this.options.retryDelayMs ?? 5_000);
    this.retryTimer.unref();
  }
}
