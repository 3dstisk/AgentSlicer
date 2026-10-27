import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { logApiFailure } from "./diagnostics.js";

export const sessionIdSchema = z.uuid();
export const actorSchema = z
  .object({ id: z.string().min(1).max(128), kind: z.enum(["human", "agent"]) })
  .strict();
export const projectBindingSchema = z.object({
  project_id: z.string(),
  revision: z.number().int().nonnegative(),
});
export const artifactSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string(),
  kind: z.enum(["checkpoint", "output", "geometry", "toolpaths"]),
  project_id: z.string().optional(),
  revision: z.number().int().optional(),
  /** Toolpaths: the slice job they preview. */
  slice_job_id: z.string().optional(),
  source_filename: z
    .string()
    .regex(/^editor-[a-f0-9-]+\.(?:3mf|scene\.bin|toolpath\.bin|gcode|gcode\.3mf)$/)
    .optional(),
});
export const sessionRecordSchema = z.object({
  id: sessionIdSchema,
  owner_id: z.string(),
  creation_key: z.string(),
  title: z.string(),
  status: z.enum(["open", "completed", "abandoned"]),
  created_at: z.number(),
  updated_at: z.number(),
  generation: z.number().int(),
  native: projectBindingSchema.nullable(),
  dirty: z.boolean(),
  lease: z
    .object({ id: z.uuid(), actor: actorSchema, expires_at: z.number() })
    .nullable(),
  checkpoints: z.array(artifactSchema),
  artifacts: z.array(artifactSchema),
  uploads: z.record(
    z.string(),
    z.object({
      path: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      complete: z.boolean().default(false),
      expires_at: z.number().optional(),
    }),
  ),
  jobs: z.record(
    z.string(),
    z.object({
      command: z.string(),
      state: z.string(),
      checkpointed: z.boolean(),
      output_filename: z.string().optional(),
    }),
  ),
  restore_upload: z
    .object({
      path: z.string(),
      expected_revision: z.number().int().nonnegative(),
      state: z.enum(["pending", "published", "failed"]),
    })
    .nullable()
    .default(null),
  recovery_reason: z.string().nullable(),
});
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type SessionActor = z.infer<typeof actorSchema>;
export type SessionArtifact = z.infer<typeof artifactSchema>;

export class SessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionError";
  }
}

export class SessionStore {
  private constructor(
    readonly root: string,
    private readonly db: DatabaseSync,
    private readonly lock: DatabaseSync,
    private readonly key: Buffer,
  ) {}

  static async open(root: string): Promise<SessionStore> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink())
      throw new Error("Session root must not be a symlink");
    await chmod(root, 0o700);
    for (const filename of ["sessions.sqlite", "owner.sqlite"]) {
      const handle = await open(
        join(root, filename),
        constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
    }
    const lock = new DatabaseSync(join(root, "owner.sqlite"), { timeout: 0 });
    let db: DatabaseSync | undefined;
    try {
      lock.exec(
        "PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;",
      );
      db = new DatabaseSync(join(root, "sessions.sqlite"));
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, creation_key TEXT NOT NULL,
          payload TEXT NOT NULL CHECK(json_valid(payload)), UNIQUE(owner_id,creation_key));
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL, details TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime(id INTEGER PRIMARY KEY CHECK(id=1), active_session TEXT);
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value)));
        INSERT OR IGNORE INTO runtime(id,active_session) VALUES(1,NULL);`);
      const keyPath = join(root, "capability.key");
      const existingRecords =
        Number(
          db.prepare("SELECT COUNT(*) AS count FROM sessions").get()?.count,
        ) > 0;
      let createdKey = false;
      const handle = await open(
        keyPath,
        constants.O_RDWR | constants.O_NOFOLLOW,
      ).catch(async (error: unknown) => {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) ||
          existingRecords
        )
          throw error;
        createdKey = true;
        return open(
          keyPath,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_RDWR |
            constants.O_NOFOLLOW,
          0o600,
        );
      });
      const key = Buffer.alloc(32);
      try {
        await handle.chmod(0o600);
        if (createdKey) {
          await handle.writeFile(randomBytes(32));
          await handle.sync();
        }
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.size !== 32)
          throw new Error(
            "Session capability key must be a regular file of exactly 32 bytes",
          );
        const read = await handle.read(key, 0, 32, 0);
        if (read.bytesRead !== 32)
          throw new Error("Session capability key is invalid");
      } finally {
        await handle.close();
      }
      if (createdKey) {
        const folder = await open(root, "r");
        try {
          await folder.sync();
        } finally {
          await folder.close();
        }
      }
      return new SessionStore(root, db, lock, key);
    } catch (error) {
      logApiFailure("session.store.open", error);
      db?.close();
      lock.close();
      throw new Error(
        "Cannot acquire the durable session store; stop the other adapter or inspect SQLite/filesystem permissions",
        { cause: error },
      );
    }
  }

  token(id: string): string {
    return createHmac("sha256", this.key).update(id).digest("hex");
  }
  leaseToken(session: SessionRecord): string {
    if (!session.lease)
      throw new SessionError(
        "session_lease_expired",
        "Session has no editing lease",
      );
    return this.token(
      `lease:${session.id}:${session.lease.id}:${session.lease.actor.kind}:${session.lease.actor.id}`,
    );
  }
  authorizeLease(session: SessionRecord, token: string): void {
    const actual = Buffer.from(token);
    const expected = Buffer.from(this.leaseToken(session));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new SessionError(
        "session_owner_conflict",
        "The editing lease belongs to another human or agent",
        403,
      );
  }
  authorize(id: string, token: string | undefined): SessionRecord {
    const actual = Buffer.from(token ?? "");
    const expected = Buffer.from(this.token(id));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new SessionError(
        "session_access_denied",
        "Session access denied",
        403,
      );
    return this.get(id);
  }
  get(id: string): SessionRecord {
    const row = this.db
      .prepare("SELECT payload FROM sessions WHERE id=?")
      .get(id);
    if (!row)
      throw new SessionError("session_not_found", "Session not found", 404);
    return sessionRecordSchema.parse(JSON.parse(String(row.payload)));
  }
  list(owner: string): SessionRecord[] {
    return this.db
      .prepare(
        "SELECT payload FROM sessions WHERE owner_id=? ORDER BY rowid DESC",
      )
      .all(owner)
      .map((row) => sessionRecordSchema.parse(JSON.parse(String(row.payload))));
  }
  create(owner: string, creationKey: string, title: string): SessionRecord {
    const existing = this.db
      .prepare("SELECT id FROM sessions WHERE owner_id=? AND creation_key=?")
      .get(owner, creationKey);
    if (existing) return this.get(String(existing.id));
    const count = this.db
      .prepare("SELECT COUNT(*) AS count FROM sessions")
      .get();
    if (Number(count?.count) >= 100)
      throw new SessionError(
        "session_capacity",
        "Delete completed or abandoned sessions before creating more",
        429,
      );
    const now = Date.now();
    const session: SessionRecord = {
      id: randomUUID(),
      owner_id: owner,
      creation_key: creationKey,
      title,
      status: "open",
      created_at: now,
      updated_at: now,
      generation: 0,
      native: null,
      dirty: false,
      lease: null,
      checkpoints: [],
      artifacts: [],
      uploads: {},
      jobs: {},
      restore_upload: null,
      recovery_reason: null,
    };
    this.db
      .prepare(
        "INSERT INTO sessions(id,owner_id,creation_key,payload) VALUES(?,?,?,?)",
      )
      .run(session.id, owner, creationKey, JSON.stringify(session));
    this.audit(session.id, "created");
    return session;
  }
  save(session: SessionRecord): void {
    session.updated_at = Date.now();
    this.db
      .prepare("UPDATE sessions SET payload=? WHERE id=?")
      .run(JSON.stringify(sessionRecordSchema.parse(session)), session.id);
  }
  all(): SessionRecord[] {
    return this.db
      .prepare("SELECT payload FROM sessions")
      .all()
      .map((row) => sessionRecordSchema.parse(JSON.parse(String(row.payload))));
  }
  storageBytes(): number {
    let bytes = 0;
    for (const row of this.db.prepare("SELECT payload FROM sessions").all()) {
      const record = sessionRecordSchema.parse(JSON.parse(String(row.payload)));
      for (const artifact of [...record.checkpoints, ...record.artifacts])
        bytes += artifact.bytes;
      for (const upload of Object.values(record.uploads)) bytes += upload.bytes;
    }
    const baseline = this.setting("baseline");
    if (baseline) bytes += artifactSchema.parse(baseline).bytes;
    return bytes;
  }
  setting(key: string): unknown {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key=?")
      .get(key);
    return row ? JSON.parse(String(row.value)) : null;
  }
  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  active(): string | null {
    const row = this.db
      .prepare("SELECT active_session FROM runtime WHERE id=1")
      .get();
    return row?.active_session ? String(row.active_session) : null;
  }
  setActive(id: string | null): void {
    this.db.prepare("UPDATE runtime SET active_session=? WHERE id=1").run(id);
  }
  audit(
    id: string,
    action: string,
    details: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit(session_id,action,at,details) VALUES(?,?,?,?)",
      )
      .run(id, action, Date.now(), JSON.stringify(details));
  }
  remove(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id=?").run(id);
    this.audit(id, "deleted");
  }
  close(): void {
    this.db.close();
    this.lock.close();
  }
}
