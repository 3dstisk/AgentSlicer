import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { copySessionFile } from "./session-files.js";
import { z } from "zod";
import { logApiFailure } from "./diagnostics.js";
import { OutputManager } from "./outputs.js";
import {
  artifactSchema,
  SessionError,
  SessionStore,
  type SessionRecord,
  type SessionActor,
  type SessionArtifact,
} from "./session-store.js";
import { nativeJobSchema, type SessionEngine } from "./session-engine.js";
import { UploadManager } from "./uploads.js";

const SESSION_OUTPUT_LIMIT = 32;
const MUTATIONS = new Set([
  "model_import",
  "object_transform",
  "object_auto_orient",
  "scene_arrange",
  "plate_add",
  "plate_rename",
  "plate_delete",
  "plate_lock",
  "plate_move_to_front",
  "presets_select",
  "settings_apply",
]);
const ALLOWED_COMMANDS = new Set([
  ...MUTATIONS,
  "scene_get",
  "presets_list",
  "settings_get",
  "settings_describe",
  "slice_start",
  "job_get",
  "job_cancel",
  "gcode_export",
  "gcode_3mf_export",
  "project_save",
]);
const ARTIFACT_COMMANDS = new Set([
  "gcode_export",
  "gcode_3mf_export",
  "project_save",
  "scene_export",
]);

export class SessionManager {
  private storePromise?: Promise<SessionStore>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private readonly uploads = new Map<string, UploadManager>();
  private readonly timer;
  constructor(
    private readonly options: {
      root: string;
      workspaceRoot: string;
      outputRoot: string;
      maxBytes: number;
      maxStorageBytes?: number;
      uploadTtlMs: number;
      leaseTtlMs: number;
      engine: SessionEngine;
      now?: () => number;
    },
  ) {
    this.timer = setInterval(() => {
      if (!this.storePromise || this.closed) return;
      void this.exclusive(() => this.tick()).catch((error: unknown) =>
        logApiFailure("session.monitor", error),
      );
    }, 1000);
    this.timer.unref();
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private store() {
    return (this.storePromise ??= this.initializeStore());
  }
  private async initializeStore() {
    const store = await SessionStore.open(this.options.root);
    try {
      for (const session of store.all()) {
        const retained = new Set(
          [...session.checkpoints, ...session.artifacts].map(
            (item) => item.filename,
          ),
        );
        for (const filename of await readdir(this.directory(session.id)).catch(
          (error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return [];
            throw error;
          },
        ))
          if (!retained.has(filename))
            await rm(join(this.directory(session.id), filename), {
              force: true,
            });
        await this.cleanupPublished(session);
      }
      const baseline = store.setting("baseline");
      if (baseline)
        await this.cleanupNativeSource(artifactSchema.parse(baseline));
      await this.cleanupNativeOutputs(store);
      return store;
    } catch (error) {
      logApiFailure("session.store.reclaim", error);
      store.close();
      throw error;
    }
  }
  private async cleanupNativeSource(artifact: SessionArtifact) {
    if (artifact.source_filename)
      await rm(join(this.options.outputRoot, artifact.source_filename), {
        force: true,
      });
  }
  private async cleanupPublished(session: SessionRecord) {
    for (const artifact of [...session.checkpoints, ...session.artifacts])
      await this.cleanupNativeSource(artifact);
  }
  private async publishArtifactRecord(
    store: SessionStore,
    session: SessionRecord,
    artifact: SessionArtifact,
    rollback: () => void,
  ) {
    try {
      store.save(session);
    } catch (error) {
      rollback();
      logApiFailure(
        `session.${session.id}.artifact.${artifact.id}.commit`,
        error,
      );
      await rm(join(this.directory(session.id), artifact.filename), {
        force: true,
      }).catch((cleanup: unknown) =>
        logApiFailure("session.artifact.remove_unpublished", cleanup),
      );
      throw error;
    }
  }
  private async cleanupNativeOutputs(store: SessionStore) {
    const pending = new Set(
      store.all().flatMap((session) =>
        Object.values(session.jobs)
          .filter(
            (job) =>
              !job.checkpointed &&
              !["failed", "cancelled", "interrupted"].includes(job.state),
          )
          .map((job) => job.output_filename)
          .filter((filename): filename is string => Boolean(filename)),
      ),
    );
    for (const filename of await readdir(this.options.outputRoot))
      if (
        /^editor-[a-f0-9-]+\.(?:3mf|scene\.bin|gcode|gcode\.3mf)$/.test(
          filename,
        ) &&
        !pending.has(filename)
      )
        await rm(join(this.options.outputRoot, filename), { force: true });
  }
  private observeRevision(
    store: SessionStore,
    session: SessionRecord,
    revision: number,
  ) {
    if (session.native && session.native.revision !== revision) {
      session.native.revision = revision;
      session.dirty = true;
      store.save(session);
    }
  }
  private async cleanupUploads(store: SessionStore, session: SessionRecord) {
    for (const upload of Object.values(session.uploads))
      await rm(
        join(this.options.workspaceRoot, "uploads", basename(upload.path)),
        { force: true },
      );
    session.uploads = {};
    this.uploads.delete(session.id);
    store.save(session);
  }
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new SessionError(
          "session_service_closed",
          "Session service is shutting down",
          503,
        ),
      );
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
  async legacy<T>(name: string, operation: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      if (
        name !== "slicer_status" &&
        ((await this.store()).active() ||
          (await this.store()).setting("editor_worker"))
      )
        throw new SessionError(
          "worker_session_owned",
          "Use the scoped session API while an editor session owns this worker",
        );
      return operation();
    });
  }
  async guardLegacyFiles(): Promise<void> {
    if (
      (await this.store()).active() ||
      (await this.store()).setting("editor_worker")
    )
      throw new SessionError(
        "worker_session_owned",
        "Use session-scoped uploads and artifacts",
        403,
      );
  }
  private public(session: SessionRecord) {
    return {
      id: session.id,
      title: session.title,
      status: session.status,
      generation: session.generation,
      native: session.native,
      lease: session.lease,
      dirty: session.dirty,
      updated_at: session.updated_at,
      checkpoint: session.checkpoints[0]
        ? {
            id: session.checkpoints[0].id,
            sha256: session.checkpoints[0].sha256,
          }
        : null,
      recovery_reason: session.recovery_reason,
      artifacts: session.artifacts.map(
        ({ filename: _filename, source_filename: _source, ...artifact }) =>
          artifact,
      ),
    };
  }
  async list(owner: string) {
    return (await this.store())
      .list(owner)
      .map((session) => this.public(session));
  }
  async create(owner: string, key: string, title: string) {
    const store = await this.store();
    const session = store.create(owner, key, title);
    return { session: this.public(session), token: store.token(session.id) };
  }
  async read(id: string, token?: string) {
    return this.public((await this.store()).authorize(id, token));
  }
  private lease(
    session: SessionRecord,
    leaseToken: string,
    store: SessionStore,
    actor?: SessionActor,
  ): void {
    if (!session.lease || session.lease.expires_at <= this.now())
      throw new SessionError(
        "session_lease_expired",
        "Open the session to acquire a current editing lease",
      );
    store.authorizeLease(session, leaseToken);
    if (store.active() !== session.id)
      throw new SessionError(
        "session_recovery_required",
        "Reopen the session to acquire the active worker",
      );
    if (
      actor &&
      (actor.id !== session.lease.actor.id ||
        actor.kind !== session.lease.actor.kind)
    )
      throw new SessionError(
        "session_owner_conflict",
        "The session is owned by another human or agent",
      );
    if (!session.native)
      throw new SessionError(
        "session_recovery_required",
        "Reopen the session to restore its native project",
      );
  }
  private async reconcile(store: SessionStore): Promise<void> {
    const active = store.active();
    if (!active) return;
    const session = store.get(active);
    const native = await this.options.engine.status();
    if (!session.native || native.project_id !== session.native.project_id) {
      if (native.project_id && store.setting("editor_worker"))
        store.setSetting("idle_project", native.project_id);
      session.native = null;
      session.lease = null;
      session.recovery_reason = "worker_restarted";
      for (const job of Object.values(session.jobs))
        if (!["succeeded", "failed", "cancelled"].includes(job.state))
          job.state = "interrupted";
      store.save(session);
      store.setActive(null);
      store.audit(session.id, "worker_lost");
    } else this.observeRevision(store, session, native.revision);
  }
  async open(id: string, token: string | undefined, actor: SessionActor) {
    return this.exclusive(async () => {
      const store = await this.store();
      store.authorize(id, token);
      await this.reconcile(store);
      await this.expire(store);
      const session = store.get(id);
      if (session.status !== "open")
        throw new SessionError(
          "session_closed",
          "Completed or abandoned sessions cannot be edited",
        );
      const active = store.active();
      if (active) {
        if (active !== id)
          throw new SessionError(
            "worker_capacity",
            "Another editor session owns this worker",
            409,
          );
        if (
          session.lease &&
          session.lease.actor.id === actor.id &&
          session.lease.actor.kind === actor.kind
        ) {
          session.lease.expires_at = this.now() + this.options.leaseTtlMs;
          store.save(session);
          return {
            ...this.public(session),
            lease_token: store.leaseToken(session),
          };
        }
        throw new SessionError(
          "session_owner_conflict",
          "Transfer ownership before another human or agent edits this session",
        );
      }
      const status = await this.options.engine.status();
      if (
        !status.capabilities.includes("project_restore") ||
        !status.capabilities.includes("scene_export")
      )
        throw new SessionError(
          "native_upgrade_required",
          "This worker needs the native session/geometry build",
          503,
        );
      if (
        status.project_id &&
        status.project_id !== store.setting("idle_project") &&
        !store.setting("editor_worker")
      )
        throw new SessionError(
          "worker_in_use",
          "A legacy native project owns this worker; finish that work or restart a dedicated worker",
        );
      store.setSetting("editor_worker", true);
      store.setActive(id);
      try {
        let checkpoint = session.checkpoints[0];
        if (!checkpoint) {
          const storedBaseline = store.setting("baseline");
          const baseline = storedBaseline
            ? artifactSchema.parse(storedBaseline)
            : null;
          if (baseline) checkpoint = baseline;
          else {
            session.native = await this.options.engine.create();
            store.setSetting("idle_project", session.native.project_id);
            const saved = await this.saveNative(
              session,
              "baseline.3mf",
              "checkpoint",
              this.options.root,
            );
            store.setSetting("baseline", saved);
            await this.cleanupNativeSource(saved);
            checkpoint = saved;
          }
        }
        const directory = session.checkpoints.length
          ? this.directory(session.id)
          : this.options.root;
        const source = join(directory, checkpoint.filename);
        const restoreDir = join(this.options.workspaceRoot, "editor-restore");
        await mkdir(restoreDir, { recursive: true, mode: 0o700 });
        const restorePath = join(restoreDir, `${randomUUID()}.3mf`);
        await this.copyVerified(source, restorePath, checkpoint);
        try {
          const current = await this.options.engine.status();
          session.native = await this.options.engine.restore(
            restorePath,
            current.revision,
          );
        } finally {
          await rm(restorePath, { force: true });
        }
        session.generation++;
        session.lease = {
          id: randomUUID(),
          actor,
          expires_at: this.now() + this.options.leaseTtlMs,
        };
        await this.cleanupUploads(store, session);
        session.jobs = {};
        session.dirty = false;
        store.save(session);
        if (!session.checkpoints.length) await this.checkpoint(store, session);
        store.audit(id, "opened", { actor, generation: session.generation });
        return {
          ...this.public(session),
          lease_token: store.leaseToken(session),
        };
      } catch (error) {
        logApiFailure(`session.${id}.open`, error);
        if (session.native)
          store.setSetting("idle_project", session.native.project_id);
        session.native = null;
        session.lease = null;
        session.recovery_reason = "restore_failed";
        store.save(session);
        store.setActive(null);
        throw error;
      }
    });
  }
  private directory(id: string) {
    return join(this.options.root, id);
  }
  private async copyVerified(
    source: string,
    target: string,
    artifact: SessionArtifact,
  ): Promise<void> {
    const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    await copySessionFile(
      input,
      target,
      artifact.bytes,
      this.options.maxBytes,
      artifact.sha256,
    );
  }

  private async saveNative(
    session: SessionRecord,
    filename: string,
    kind: SessionArtifact["kind"],
    directory = this.directory(session.id),
  ): Promise<SessionArtifact> {
    if (!session.native)
      throw new SessionError(
        "session_recovery_required",
        "No native session project is attached",
      );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const nativeName = `editor-${randomUUID()}.${kind === "geometry" ? "scene.bin" : "3mf"}`;
    const start = await this.options.engine.command(
      kind === "geometry" ? "scene_export" : "project_save",
      {
        project_id: session.native.project_id,
        expected_revision: session.native.revision,
        output_path: nativeName,
      },
    );
    const job = await this.options.engine.wait(
      z.object({ job_id: z.string() }).parse(start).job_id,
    );
    const result = z
      .object({ path: z.string(), bytes: z.number() })
      .parse(job.result);
    if (basename(result.path) !== nativeName)
      throw new SessionError(
        "artifact_not_owned",
        "Native output identity differs from the requested session artifact",
        502,
      );
    try {
      return await this.collectOutput(
        result.path,
        result.bytes,
        directory,
        filename,
        kind,
      );
    } catch (error) {
      logApiFailure(`session.${session.id}.collect_output`, error);
      await rm(join(this.options.outputRoot, nativeName), {
        force: true,
      }).catch((cleanup: unknown) =>
        logApiFailure("session.output.cleanup", cleanup),
      );
      throw error;
    }
  }
  private async collectOutput(
    path: string,
    bytes: number,
    directory: string,
    filename: string,
    kind: SessionArtifact["kind"],
  ): Promise<SessionArtifact> {
    if (bytes > this.options.maxBytes)
      throw new SessionError(
        "artifact_too_large",
        "Native artifact exceeds the session file limit",
        413,
      );
    const store = await this.store();
    if (
      store.storageBytes() + bytes >
      (this.options.maxStorageBytes ?? this.options.maxBytes * 4)
    )
      throw new SessionError(
        "session_storage_full",
        "Delete completed or abandoned sessions before saving more artifacts",
        507,
      );
    const artifact = await new OutputManager(this.options.outputRoot).open(
      basename(path),
    );
    if (!artifact)
      throw new SessionError(
        "artifact_invalid",
        "Native output is missing",
        503,
      );
    if (artifact.bytes !== bytes) {
      await artifact.handle.close();
      throw new SessionError(
        "artifact_invalid",
        "Native output size has changed",
        503,
      );
    }
    const digest = await copySessionFile(
      artifact.handle,
      join(directory, filename),
      bytes,
      this.options.maxBytes,
    );
    return {
      id: randomUUID(),
      filename,
      bytes,
      sha256: digest,
      kind,
      source_filename: basename(path),
    };
  }

  private async checkpoint(
    store: SessionStore,
    session: SessionRecord,
  ): Promise<void> {
    const status = await this.options.engine.status();
    if (!session.native || status.project_id !== session.native.project_id)
      throw new SessionError(
        "session_recovery_required",
        "Native project identity changed",
      );
    this.observeRevision(store, session, status.revision);
    const checkpoint = await this.saveNative(
      session,
      `${randomUUID()}.3mf`,
      "checkpoint",
    );
    const previous = session.checkpoints;
    session.checkpoints = [checkpoint, ...previous].slice(0, 2);
    session.dirty = false;
    await this.publishArtifactRecord(store, session, checkpoint, () => {
      session.checkpoints = previous;
      session.dirty = true;
    });
    store.audit(session.id, "checkpoint", {
      id: checkpoint.id,
      revision: status.revision,
    });
    await this.cleanupNativeSource(checkpoint);
    for (const obsolete of previous.slice(1))
      await rm(join(this.directory(session.id), obsolete.filename), {
        force: true,
      });
  }
  async heartbeat(id: string, token: string | undefined, leaseToken: string) {
    return this.exclusive(async () => {
      const store = await this.store();
      const session = store.authorize(id, token);
      this.lease(session, leaseToken, store);
      session.lease!.expires_at = this.now() + this.options.leaseTtlMs;
      store.save(session);
      return this.public(session);
    });
  }
  async transfer(
    id: string,
    token: string | undefined,
    leaseToken: string,
    actor: SessionActor,
  ) {
    return this.exclusive(async () => {
      const store = await this.store();
      const session = store.authorize(id, token);
      this.lease(session, leaseToken, store);
      this.requireIdle(session);
      await this.checkpoint(store, session);
      session.lease = {
        id: randomUUID(),
        actor,
        expires_at: this.now() + this.options.leaseTtlMs,
      };
      store.save(session);
      store.audit(id, "ownership_transferred", { actor });
      return {
        ...this.public(session),
        lease_token: store.leaseToken(session),
      };
    });
  }
  private requireIdle(session: SessionRecord) {
    if (
      Object.values(session.jobs).some((job) =>
        ["running", "queued"].includes(job.state),
      )
    )
      throw new SessionError(
        "session_job_running",
        "Wait for or cancel the current native job first",
      );
  }
  async command(
    id: string,
    token: string | undefined,
    leaseToken: string,
    name: string,
    params: Record<string, unknown>,
  ) {
    return this.exclusive(async () => {
      const store = await this.store();
      const session = store.authorize(id, token);
      this.lease(session, leaseToken, store);
      if (!ALLOWED_COMMANDS.has(name))
        throw new SessionError(
          "command_not_available",
          "Command is not available inside an editor session",
          404,
        );
      if (
        params.project_id !== undefined &&
        params.project_id !== session.native!.project_id
      )
        throw new SessionError(
          "project_mismatch",
          "Refresh the native project identity after session recovery",
        );
      if (
        name === "model_import" &&
        !Object.values(session.uploads).some(
          (upload) => upload.path === String(params.path),
        )
      )
        throw new SessionError(
          "upload_not_owned",
          "Import requires a file uploaded to this session",
          403,
        );
      if (
        (name === "job_get" || name === "job_cancel") &&
        !Object.hasOwn(session.jobs, String(params.job_id))
      )
        throw new SessionError(
          "job_not_owned",
          "Job does not belong to this session",
          403,
        );
      const input = { ...params };
      if (ARTIFACT_COMMANDS.has(name)) {
        const pending = Object.values(session.jobs).filter(
          (job) =>
            ARTIFACT_COMMANDS.has(job.command) &&
            !job.checkpointed &&
            !["failed", "cancelled", "interrupted"].includes(job.state),
        ).length;
        if (
          session.artifacts.filter((artifact) => artifact.kind === "output")
            .length +
            pending >=
          SESSION_OUTPUT_LIMIT
        )
          throw new SessionError(
            "session_output_limit",
            "This session has reached its output retention limit",
            429,
          );
        const extension =
          name === "gcode_export"
            ? "gcode"
            : name === "project_save"
              ? "3mf"
              : "gcode.3mf";
        input.output_path = `editor-${randomUUID()}.${extension}`;
        input.overwrite = false;
      }
      const result = await this.options.engine.command(name, input);
      if (
        typeof result.job_id === "string" &&
        name !== "job_get" &&
        name !== "job_cancel"
      )
        session.jobs[result.job_id] = {
          command: name,
          state: String(result.state),
          checkpointed: false,
          ...(ARTIFACT_COMMANDS.has(name)
            ? { output_filename: String(input.output_path) }
            : {}),
        };
      if (MUTATIONS.has(name)) {
        session.dirty = true;
        store.save(session);
        if (typeof result.job_id !== "string")
          await this.checkpoint(store, session);
      }
      if (name === "job_get" || name === "job_cancel")
        await this.processJob(store, session, nativeJobSchema.parse(result));
      session.lease!.expires_at = this.now() + this.options.leaseTtlMs;
      store.save(session);
      return { result, session: this.public(session) };
    });
  }
  private async processJob(
    store: SessionStore,
    session: SessionRecord,
    job: z.infer<typeof nativeJobSchema>,
  ) {
    const tracked = session.jobs[job.job_id];
    if (!tracked)
      throw new SessionError("job_not_owned", "Unknown session job", 403);
    tracked.state = job.state;
    let collected: SessionArtifact | undefined;
    if (job.state === "succeeded" && !tracked.checkpointed) {
      if (ARTIFACT_COMMANDS.has(tracked.command)) {
        if (
          session.artifacts.filter((artifact) => artifact.kind === "output")
            .length >= SESSION_OUTPUT_LIMIT
        )
          throw new SessionError(
            "session_output_limit",
            "This session has reached its output retention limit",
            429,
          );
        const output = z
          .object({ path: z.string(), bytes: z.number() })
          .parse(job.result);
        if (basename(output.path) !== tracked.output_filename)
          throw new SessionError(
            "artifact_not_owned",
            "Native output does not belong to this session job",
            502,
          );
        const extension =
          tracked.command === "gcode_export"
            ? "gcode"
            : tracked.command === "project_save"
              ? "3mf"
              : "gcode.3mf";
        const artifact = await this.collectOutput(
          output.path,
          output.bytes,
          this.directory(session.id),
          `${randomUUID()}.${extension}`,
          "output",
        );
        session.artifacts.push(artifact);
        collected = artifact;
      }
      if (MUTATIONS.has(tracked.command)) await this.checkpoint(store, session);
      tracked.checkpointed = true;
    }
    if (collected) {
      const artifact = collected;
      await this.publishArtifactRecord(store, session, artifact, () => {
        session.artifacts = session.artifacts.filter(
          (item) => item.id !== artifact.id,
        );
        tracked.checkpointed = false;
      });
    } else store.save(session);
    await this.cleanupPublished(session);
  }
  async prepareUpload(
    id: string,
    token: string | undefined,
    leaseToken: string,
    input: { filename: string; bytes: number; sha256: string },
  ) {
    return this.exclusive(async () => {
      const store = await this.store();
      const session = store.authorize(id, token);
      this.lease(session, leaseToken, store);
      let uploads = this.uploads.get(id);
      if (!uploads) {
        uploads = new UploadManager(
          this.options.workspaceRoot,
          this.options.maxBytes,
          this.options.uploadTtlMs,
        );
        this.uploads.set(id, uploads);
      }
      if (
        store.storageBytes() + input.bytes >
        (this.options.maxStorageBytes ?? this.options.maxBytes * 4)
      )
        throw new SessionError(
          "session_storage_full",
          "Delete completed or abandoned sessions before uploading more files",
          507,
        );
      const result = await uploads.prepare(input);
      session.uploads[result.upload_id] = {
        path: result.workspace_path,
        bytes: input.bytes,
      };
      store.save(session);
      return {
        ...result,
        upload_path: `/api/v1/sessions/${id}/uploads/${result.upload_id}`,
      };
    });
  }
  async receiveUpload(
    id: string,
    token: string | undefined,
    leaseToken: string,
    uploadId: string,
    request: import("node:http").IncomingMessage,
  ) {
    return this.exclusive(async () => {
      const store = await this.store();
      const session = store.authorize(id, token);
      this.lease(session, leaseToken, store);
      if (!Object.hasOwn(session.uploads, uploadId))
        throw new SessionError(
          "upload_not_owned",
          "Upload does not belong to this session",
          403,
        );
      const uploads = this.uploads.get(id);
      if (!uploads)
        throw new SessionError(
          "upload_expired",
          "Prepare a fresh upload after adapter restart",
          410,
        );
      return uploads.receive(uploadId, request);
    });
  }
  async finish(
    id: string,
    token: string | undefined,
    leaseToken: string,
    action: "release" | "complete" | "abandon" | "checkpoint",
  ) {
    return this.exclusive(async () => {
      const store = await this.store();
      const session = store.authorize(id, token);
      if (action === "complete" && session.status === "completed")
        return this.public(session);
      if (action === "abandon" && session.status === "abandoned")
        return this.public(session);
      if (
        action === "abandon" &&
        !session.native &&
        !session.lease &&
        store.active() !== id
      ) {
        await this.cleanupUploads(store, session);
        session.status = "abandoned";
        store.save(session);
        store.audit(id, "abandon");
        return this.public(session);
      }
      this.lease(session, leaseToken, store);
      this.requireIdle(session);
      if (action !== "abandon") await this.checkpoint(store, session);
      if (action !== "checkpoint") {
        const idle = await this.options.engine.create();
        store.setSetting("idle_project", idle.project_id);
        await this.cleanupUploads(store, session);
        session.native = null;
        session.lease = null;
        store.setActive(null);
        if (action === "complete") session.status = "completed";
        if (action === "abandon") session.status = "abandoned";
      }
      store.save(session);
      store.audit(id, action);
      return this.public(session);
    });
  }
  async geometry(
    id: string,
    token: string | undefined,
    leaseToken: string,
    expectedRevision: number,
  ) {
    return this.exclusive(async () => {
      const store = await this.store();
      const session = store.authorize(id, token);
      this.lease(session, leaseToken, store);
      this.requireIdle(session);
      const status = await this.options.engine.status();
      if (
        status.project_id !== session.native!.project_id ||
        status.revision !== expectedRevision
      )
        throw new SessionError(
          "revision_conflict",
          "Geometry export requires the current native revision",
        );
      this.observeRevision(store, session, status.revision);
      const saved = await this.saveNative(
        session,
        `${randomUUID()}.scene.bin`,
        "geometry",
      );
      const artifact = {
        ...saved,
        project_id: status.project_id!,
        revision: expectedRevision,
      };
      const previous = session.artifacts.filter(
        (item) => item.kind === "geometry",
      );
      const previousArtifacts = session.artifacts;
      session.artifacts = [
        ...session.artifacts.filter((item) => item.kind !== "geometry"),
        artifact,
      ];
      await this.publishArtifactRecord(store, session, artifact, () => {
        session.artifacts = previousArtifacts;
      });
      await this.cleanupNativeSource(artifact);
      for (const old of previous)
        await rm(join(this.directory(id), old.filename), { force: true });
      return {
        artifact_id: artifact.id,
        project_id: status.project_id,
        revision: expectedRevision,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      };
    });
  }
  async artifact(id: string, token: string | undefined, artifactId: string) {
    const session = (await this.store()).authorize(id, token);
    const artifact = [...session.artifacts, ...session.checkpoints].find(
      (item) => item.id === artifactId,
    );
    if (!artifact)
      throw new SessionError(
        "artifact_not_found",
        "Artifact does not belong to this session",
        404,
      );
    if (artifact.kind === "geometry") {
      const current = await this.options.engine.status();
      if (
        !session.native ||
        current.project_id !== artifact.project_id ||
        current.revision !== artifact.revision
      )
        throw new SessionError(
          "revision_conflict",
          "Scene geometry is stale; export the current revision",
        );
    }
    const handle = await open(
      join(this.directory(id), artifact.filename),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== artifact.bytes) {
      await handle.close();
      throw new SessionError(
        "artifact_invalid",
        "Session artifact has changed",
        503,
      );
    }
    return { ...artifact, handle };
  }
  async snapshot(id: string, token: string | undefined, jobId?: string) {
    const store = await this.store();
    const session = store.authorize(id, token);
    let job: Record<string, unknown> | null = null;
    if (jobId) {
      if (!Object.hasOwn(session.jobs, jobId))
        throw new SessionError(
          "job_not_owned",
          "Job does not belong to this session",
          403,
        );
      const status = await this.options.engine.status();
      if (session.native && status.project_id === session.native.project_id)
        job = await this.options.engine.command("job_get", { job_id: jobId });
    }
    return { session: this.public(session), job };
  }
  async remove(id: string, token: string | undefined) {
    return this.exclusive(async () => {
      const store = await this.store();
      const session = store.authorize(id, token);
      if (session.status === "open" || store.active() === id)
        throw new SessionError(
          "session_still_open",
          "Complete or abandon the session before deleting its files",
        );
      await this.cleanupUploads(store, session);
      await rm(this.directory(id), { recursive: true, force: true });
      store.remove(id);
    });
  }
  private async expire(store: SessionStore) {
    const id = store.active();
    if (!id) return;
    const session = store.get(id);
    if (!session.lease || session.lease.expires_at > this.now()) return;
    for (const [jobId, tracked] of Object.entries(session.jobs))
      if (["running", "queued"].includes(tracked.state)) {
        const job = nativeJobSchema.parse(
          await this.options.engine.command("job_cancel", { job_id: jobId }),
        );
        await this.processJob(store, session, job);
      }
    await this.checkpoint(store, session);
    const idle = await this.options.engine.create();
    store.setSetting("idle_project", idle.project_id);
    await this.cleanupUploads(store, session);
    session.native = null;
    session.lease = null;
    session.recovery_reason = "lease_expired";
    store.save(session);
    store.setActive(null);
    store.audit(id, "lease_expired");
  }
  private async tick() {
    const store = await this.store();
    await this.reconcile(store);
    await this.expire(store);
    await this.cleanupNativeOutputs(store);
    const id = store.active();
    if (!id) return;
    const session = store.get(id);
    for (const [jobId, tracked] of Object.entries(session.jobs)) {
      if (
        !["queued", "running"].includes(tracked.state) &&
        !(tracked.state === "succeeded" && !tracked.checkpointed)
      )
        continue;
      try {
        await this.processJob(
          store,
          session,
          nativeJobSchema.parse(
            await this.options.engine.command("job_get", { job_id: jobId }),
          ),
        );
      } catch (error) {
        logApiFailure(`session.${id}.job.${jobId}.monitor`, error);
      }
    }
    if (
      session.dirty &&
      !Object.values(session.jobs).some((job) =>
        ["queued", "running"].includes(job.state),
      )
    )
      await this.checkpoint(store, session);
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.tail;
    if (this.storePromise) (await this.storePromise).close();
  }
}
