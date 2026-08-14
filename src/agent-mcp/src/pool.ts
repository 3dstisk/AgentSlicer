import { createHash, randomBytes, randomUUID } from "node:crypto";

export interface PoolWorker {
  id: string;
  baseUrl: URL;
  bearerToken: string;
}

export interface WorkerProvisioner {
  provision(): Promise<PoolWorker>;
  healthy(worker: PoolWorker): Promise<boolean>;
  reclaim(worker: PoolWorker): Promise<void>;
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
  log?: (event: PoolEvent) => void;
}

export interface PoolStats {
  target: number;
  ready: number;
  leased: number;
  starting: number;
  unhealthy: number;
  /** @deprecated Use starting. */
  warming: number;
  queued: number;
}

export interface PoolEvent {
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  reason?: string;
  workerId?: string;
  leaseId?: string;
  waitedMs?: number;
  pool: PoolStats;
}

export interface PoolMetricsSnapshot {
  leaseWait: {
    count: number;
    sumMs: number;
    buckets: ReadonlyArray<{ upperBoundMs: number; count: number }>;
  };
  allocationFailures: Readonly<Record<string, number>>;
  workerStartupFailures: number;
  workerReclamations: Readonly<Record<string, number>>;
  workerReclamationFailures: number;
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

interface PendingReclaim {
  worker: PoolWorker;
  reason: string;
  timer?: NodeJS.Timeout;
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
  private static readonly LEASE_WAIT_BUCKETS_MS = [
    10, 50, 100, 250, 500, 1_000, 5_000, 15_000, 30_000, 60_000, 300_000,
  ] as const;
  private readonly ready: PoolWorker[] = [];
  private readonly leasesByToken = new Map<string, LeaseRecord>();
  private readonly leasesById = new Map<string, LeaseRecord>();
  private readonly waiters: Waiter[] = [];
  private readonly workers = new Map<string, PoolWorker>();
  private readonly unhealthyWorkers = new Set<string>();
  private readonly pendingReclaims = new Map<string, PendingReclaim>();
  private readonly warmOperations = new Set<Promise<void>>();
  private readonly leaseWaitBuckets = WarmWorkerPool.LEASE_WAIT_BUCKETS_MS.map(() => 0);
  private readonly allocationFailures = new Map<string, number>();
  private readonly workerReclamations = new Map<string, number>();
  private leaseWaitCount = 0;
  private leaseWaitSumMs = 0;
  private workerStartupFailures = 0;
  private workerReclamationFailures = 0;
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
      starting: this.warming,
      unhealthy: this.unhealthyWorkers.size,
      warming: this.warming,
      queued: this.waiters.length,
    };
  }

  metrics(): PoolMetricsSnapshot {
    return {
      leaseWait: {
        count: this.leaseWaitCount,
        sumMs: this.leaseWaitSumMs,
        buckets: WarmWorkerPool.LEASE_WAIT_BUCKETS_MS.map((upperBoundMs, index) => ({
          upperBoundMs,
          count: this.leaseWaitBuckets[index]!,
        })),
      },
      allocationFailures: Object.fromEntries(this.allocationFailures),
      workerStartupFailures: this.workerStartupFailures,
      workerReclamations: Object.fromEntries(this.workerReclamations),
      workerReclamationFailures: this.workerReclamationFailures,
    };
  }

  retryAfterMs(): number {
    return this.options.retryDelayMs ?? 5_000;
  }

  async acquire(waitMs: number, signal?: AbortSignal): Promise<WorkerLease> {
    const startedAt = this.now();
    const deadline = startedAt + Math.max(0, waitMs);
    try {
      while (true) {
        if (this.closed) {
          throw new PoolClosedError();
        }
        if (signal?.aborted) {
          throw new PoolUnavailableError("Lease request was abandoned");
        }
        const worker = this.ready.shift();
        if (worker === undefined) {
          return await this.waitForWorker(Math.max(0, deadline - this.now()), signal);
        }

        const healthy = await this.workerHealthy(worker);
        if (this.closed) {
          throw new PoolClosedError();
        }
        if (signal?.aborted) {
          if (healthy) {
            this.offerWorker(worker);
          } else {
            await this.retireWorker(worker, "unhealthy_before_allocation");
          }
          throw new PoolUnavailableError("Lease request was abandoned");
        }
        if (healthy) {
          return this.createLease(worker);
        }

        await this.retireWorker(worker, "unhealthy_before_allocation");
        if (this.now() >= deadline) {
          throw new PoolUnavailableError();
        }
      }
    } catch (error) {
      const reason = this.allocationFailureReason(error);
      this.increment(this.allocationFailures, reason);
      this.log({
        level: reason === "client_abandoned" ? "info" : "warn",
        event: "lease_allocation_failed",
        message: error instanceof Error ? error.message : "Lease allocation failed",
        reason,
        waitedMs: Math.max(0, this.now() - startedAt),
      });
      throw error;
    } finally {
      this.observeLeaseWait(Math.max(0, this.now() - startedAt));
    }
  }

  private waitForWorker(waitMs: number, signal?: AbortSignal): Promise<WorkerLease> {
    if (this.closed) {
      return Promise.reject(new PoolClosedError());
    }
    if (signal?.aborted) {
      return Promise.reject(new PoolUnavailableError("Lease request was abandoned"));
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
        void this.releaseRecord(record, "expired");
      }
      return undefined;
    }
    if (refresh) {
      this.refreshRecord(record);
    }
    return this.publicLease(record, token);
  }

  renew(token: string, leaseId: string): WorkerLease | undefined {
    const record = this.leasesByToken.get(tokenHash(token));
    if (record === undefined || record.leaseId !== leaseId || record.expiresAt <= this.now()) {
      if (record !== undefined && record.expiresAt <= this.now()) {
        void this.releaseRecord(record, "expired");
      }
      return undefined;
    }
    this.refreshRecord(record);
    return this.publicLease(record, token);
  }

  async release(token: string, leaseId?: string): Promise<boolean> {
    const record = this.leasesByToken.get(tokenHash(token));
    if (record === undefined || (leaseId !== undefined && record.leaseId !== leaseId)) {
      return false;
    }
    if (record.expiresAt <= this.now()) {
      await this.releaseRecord(record, "expired");
      return false;
    }
    await this.releaseRecord(record, "released");
    return true;
  }

  async invalidate(token: string): Promise<void> {
    const record = this.leasesByToken.get(tokenHash(token));
    if (record !== undefined) {
      await this.releaseRecord(record, "invalidated");
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
    const pendingReclaims = [...this.pendingReclaims.values()];
    for (const reclaim of pendingReclaims) {
      if (reclaim.timer !== undefined) {
        clearTimeout(reclaim.timer);
      }
    }
    this.pendingReclaims.clear();
    this.unhealthyWorkers.clear();
    const workers = [...new Map([
      ...this.workers.values(),
      ...pendingReclaims.map(({ worker }) => worker),
    ].map((worker) => [worker.id, worker])).values()];
    this.workers.clear();
    await Promise.allSettled([
      ...workers.map((worker) => this.provisioner.reclaim(worker)),
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
    const timer = setTimeout(
      () => void this.expireRecord(record),
      Math.max(0, record.expiresAt - this.now()),
    );
    timer.unref();
    return timer;
  }

  private async expireRecord(record: LeaseRecord): Promise<void> {
    if (this.leasesById.get(record.leaseId) !== record) {
      return;
    }
    if (record.expiresAt > this.now()) {
      record.timer = this.expiryTimer(record);
      return;
    }
    await this.releaseRecord(record, "expired");
  }

  private async releaseRecord(record: LeaseRecord, reason: string): Promise<void> {
    if (this.leasesById.get(record.leaseId) !== record) {
      return;
    }
    if (record.timer !== undefined) {
      clearTimeout(record.timer);
    }
    this.leasesById.delete(record.leaseId);
    this.leasesByToken.delete(record.tokenHash);
    this.workers.delete(record.worker.id);
    await this.reclaimWorker(record.worker, reason, record.leaseId);
    void this.ensureCapacity(false);
  }

  private async retireWorker(worker: PoolWorker, reason: string): Promise<void> {
    this.workers.delete(worker.id);
    await this.reclaimWorker(worker, reason);
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
        await this.provisioner.reclaim(worker);
        return;
      }
      if (this.workers.has(worker.id)) {
        await this.provisioner.reclaim(worker);
        throw new Error(`Provisioner returned duplicate worker id: ${worker.id}`);
      }
      this.workers.set(worker.id, worker);
      const healthy = await this.workerHealthy(worker);
      if (this.closed) {
        this.workers.delete(worker.id);
        await this.provisioner.reclaim(worker);
        return;
      }
      if (!healthy) {
        ++this.workerStartupFailures;
        await this.retireWorker(worker, "startup_readiness_failed");
        this.log({
          level: "error",
          event: "worker_startup_failed",
          message: "Provisioned AgentSlicer worker failed its final readiness check",
          reason: "startup_readiness_failed",
          workerId: worker.id,
        });
        this.scheduleRetry();
        return;
      }
      this.offerWorker(worker);
    } catch (error) {
      ++this.workerStartupFailures;
      this.log({
        level: "error",
        event: "worker_startup_failed",
        message: error instanceof Error ? error.message : "AgentSlicer worker registration failed",
        reason: "registration_failed",
      });
      this.scheduleRetry();
    } finally {
      --this.warming;
    }
  }

  private offerWorker(worker: PoolWorker): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.ready.push(worker);
      return;
    }
    waiter.cleanup();
    waiter.resolve(this.createLease(worker));
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

  private async reclaimWorker(
    worker: PoolWorker,
    reason: string,
    leaseId?: string,
  ): Promise<void> {
    const previous = this.pendingReclaims.get(worker.id);
    if (previous?.timer !== undefined) {
      clearTimeout(previous.timer);
    }
    const reclaim: PendingReclaim = { worker, reason };
    this.pendingReclaims.set(worker.id, reclaim);
    this.unhealthyWorkers.add(worker.id);
    try {
      await this.provisioner.reclaim(worker);
    } catch (error) {
      ++this.workerReclamationFailures;
      this.log({
        level: "error",
        event: "worker_reclaim_failed",
        message: error instanceof Error ? error.message : "AgentSlicer worker cleanup failed",
        reason,
        workerId: worker.id,
        ...(leaseId !== undefined ? { leaseId } : {}),
      });
      if (!this.closed) {
        reclaim.timer = setTimeout(
          () => void this.reclaimWorker(worker, reason, leaseId),
          this.retryAfterMs(),
        );
        reclaim.timer.unref();
      }
      return;
    }
    if (this.pendingReclaims.get(worker.id) === reclaim) {
      this.pendingReclaims.delete(worker.id);
      this.unhealthyWorkers.delete(worker.id);
    }
    this.increment(this.workerReclamations, reason);
    this.log({
      level: reason.startsWith("unhealthy") || reason === "startup_readiness_failed"
        ? "warn"
        : "info",
      event: "worker_reclaimed",
      message: "AgentSlicer worker was reclaimed from the pool",
      reason,
      workerId: worker.id,
      ...(leaseId !== undefined ? { leaseId } : {}),
    });
  }

  private async workerHealthy(worker: PoolWorker): Promise<boolean> {
    try {
      return await this.provisioner.healthy(worker);
    } catch {
      return false;
    }
  }

  private allocationFailureReason(error: unknown): string {
    if (error instanceof PoolQueueFullError) {
      return "queue_full";
    }
    if (error instanceof PoolClosedError) {
      return "pool_closed";
    }
    if (error instanceof PoolUnavailableError && error.message.includes("abandoned")) {
      return "client_abandoned";
    }
    return "capacity_unavailable";
  }

  private observeLeaseWait(waitedMs: number): void {
    ++this.leaseWaitCount;
    this.leaseWaitSumMs += waitedMs;
    for (let index = 0; index < WarmWorkerPool.LEASE_WAIT_BUCKETS_MS.length; ++index) {
      if (waitedMs <= WarmWorkerPool.LEASE_WAIT_BUCKETS_MS[index]!) {
        ++this.leaseWaitBuckets[index]!;
      }
    }
  }

  private increment(counts: Map<string, number>, reason: string): void {
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }

  private log(event: Omit<PoolEvent, "pool">): void {
    try {
      this.options.log?.({ ...event, pool: this.stats() });
    } catch {
      // Observability must never alter lease or worker lifecycle behavior.
    }
  }
}
