import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "../src/session-store.js";
import { SessionManager } from "../src/session-manager.js";
import { TestNativeEngine } from "./fixtures/session-engine.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(
    join(tmpdir(), "editor-session-integration-test-"),
  );
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "workspace"));
  await mkdir(join(root, "outputs"));
  const engine = new TestNativeEngine(join(root, "outputs"));
  let time = 1000;
  const options = {
    root: join(root, "sessions"),
    workspaceRoot: join(root, "workspace"),
    outputRoot: join(root, "outputs"),
    maxBytes: 1024 * 1024,
    uploadTtlMs: 10000,
    leaseTtlMs: 10000,
    engine,
    now: () => time,
  };
  let manager = new SessionManager(options);
  cleanups.push(() => manager.close());
  return {
    root,
    options,
    engine,
    manager,
    advance: () => {
      time += 20000;
    },
    replace: (next: SessionManager) => {
      manager = next;
    },
  };
}
const actor = { id: "human-a", kind: "human" as const };

describe("operator session recovery and ownership", () => {
  it("rejects a stale lease after release metadata fails without resetting another session", async () => {
    const { manager, engine } = await fixture();
    const a = await manager.create("owner-a", "a", "First");
    const b = await manager.create("owner-b", "b", "Second");
    const opened = await manager.open(a.session.id, a.token, actor);
    const save = SessionStore.prototype.save;
    const saveSpy = vi.spyOn(SessionStore.prototype, "save").mockImplementation(
      function (this: SessionStore, session) {
        if (session.id === a.session.id && !session.native && !session.lease)
          throw new Error("release metadata write failed");
        return save.call(this, session);
      },
    );
    try {
      await expect(
        manager.finish(a.session.id, a.token, opened.lease_token, "release"),
      ).rejects.toThrow("release metadata write failed");
    } finally {
      saveSpy.mockRestore();
    }
    expect((await manager.read(a.session.id, a.token)).native).toEqual(
      opened.native,
    );
    await expect(
      manager.finish(a.session.id, a.token, opened.lease_token, "abandon"),
    ).rejects.toMatchObject({ code: "session_recovery_required", status: 409 });
    const second = await manager.open(b.session.id, b.token, actor);
    const createSpy = vi.spyOn(engine, "create");
    try {
      await expect(
        manager.finish(a.session.id, a.token, opened.lease_token, "abandon"),
      ).rejects.toMatchObject({ code: "session_recovery_required", status: 409 });
      expect(createSpy).not.toHaveBeenCalled();
      expect(engine.project).toBe(second.native!.project_id);
      await expect(
        manager.heartbeat(b.session.id, b.token, second.lease_token),
      ).resolves.toMatchObject({ native: second.native });
    } finally {
      createSpy.mockRestore();
    }
  });

  it("reconnects within a lease and prevents another session or legacy caller from using the worker", async () => {
    const { manager } = await fixture();
    const a = await manager.create("owner-a", "a", "First");
    const b = await manager.create("owner-b", "b", "Second");
    const opened = await manager.open(a.session.id, a.token, actor);
    const again = await manager.open(a.session.id, a.token, actor);
    expect(again.native).toEqual(opened.native);
    await expect(manager.command(a.session.id, a.token, opened.lease_token, "project_restore", { path: "/workspace/unverified.3mf", expected_revision: opened.native!.revision })).rejects.toMatchObject({ code: "command_not_available" });
    await expect(
      manager.open(b.session.id, b.token, actor),
    ).rejects.toMatchObject({ code: "worker_capacity" });
    await expect(
      manager.legacy("project_create", async () => ({})),
    ).rejects.toMatchObject({ code: "worker_session_owned" });
    await expect(manager.read(a.session.id, b.token)).rejects.toMatchObject({
      code: "session_access_denied",
    });
  });

  it("restores an acknowledged checkpoint with fresh native IDs after worker failure", async () => {
    const f = await fixture();
    const created = await f.manager.create("owner-a", "a", "Recover");
    const opened = await f.manager.open(
      created.session.id,
      created.token,
      actor,
    );
    await f.manager.command(
      created.session.id,
      created.token,
      opened.lease_token,
      "settings_apply",
      {
        project_id: opened.native!.project_id,
        expected_revision: opened.native!.revision,
        value: 42,
      },
    );
    await f.manager.close();
    const replacementEngine = new TestNativeEngine(f.options.outputRoot);
    replacementEngine.next = 100;
    const replacement = new SessionManager({
      ...f.options,
      engine: replacementEngine,
    });
    f.replace(replacement);
    const restored = await replacement.open(
      created.session.id,
      created.token,
      actor,
    );
    expect(restored.native!.project_id).not.toBe(opened.native!.project_id);
    expect(restored.generation).toBe(opened.generation + 1);
    expect(replacementEngine.value).toBe(42);
    expect(restored.recovery_reason).toBe("worker_restarted");
  });

  it("revokes old editing credentials during explicit human to agent transfer", async () => {
    const { manager } = await fixture();
    const created = await manager.create("owner", "a", "Ownership");
    const opened = await manager.open(created.session.id, created.token, actor);
    const transferred = await manager.transfer(
      created.session.id,
      created.token,
      opened.lease_token,
      { id: "agent-a", kind: "agent" },
    );
    expect(transferred.lease_token).not.toBe(opened.lease_token);
    await expect(
      manager.command(
        created.session.id,
        created.token,
        opened.lease_token,
        "scene_get",
        {},
      ),
    ).rejects.toMatchObject({ code: "session_owner_conflict" });
    expect(
      JSON.stringify(await manager.read(created.session.id, created.token)),
    ).not.toContain(transferred.lease_token);
    await expect(
      manager.command(
        created.session.id,
        created.token,
        transferred.lease_token,
        "scene_get",
        {},
      ),
    ).resolves.toBeDefined();
  });

  it("recovers after lease expiry and makes completion idempotent", async () => {
    const { manager, advance } = await fixture();
    const created = await manager.create("owner", "a", "Expiry");
    const opened = await manager.open(created.session.id, created.token, actor);
    advance();
    await expect(
      manager.heartbeat(created.session.id, created.token, opened.lease_token),
    ).rejects.toMatchObject({ code: "session_lease_expired" });
    const reopened = await manager.open(
      created.session.id,
      created.token,
      actor,
    );
    expect(reopened.recovery_reason).toBe("lease_expired");
    const completed = await manager.finish(
      created.session.id,
      created.token,
      reopened.lease_token,
      "complete",
    );
    expect(completed.status).toBe("completed");
    expect(
      (
        await manager.finish(
          created.session.id,
          created.token,
          "revoked",
          "complete",
        )
      ).status,
    ).toBe("completed");
  });

  it("keeps the last checkpoint when a subsequent native save fails", async () => {
    const { manager, engine } = await fixture();
    const created = await manager.create("owner", "a", "Save failure");
    const opened = await manager.open(created.session.id, created.token, actor);
    engine.failSave = true;
    await expect(
      manager.command(
        created.session.id,
        created.token,
        opened.lease_token,
        "settings_apply",
        {
          project_id: opened.native!.project_id,
          expected_revision: opened.native!.revision,
          value: 99,
        },
      ),
    ).rejects.toThrow("disk write failed");
    const failed = await manager.read(created.session.id, created.token);
    expect(failed.dirty).toBe(true);
    expect(failed.checkpoint).toEqual(opened.checkpoint);
  });
  it("observes adapter-only revision changes and retries failed background checkpoints", async () => {
    const f = await fixture();
    const created = await f.manager.create(
      "owner",
      "restart",
      "Adapter restart",
    );
    const opened = await f.manager.open(
      created.session.id,
      created.token,
      actor,
    );
    await f.manager.close();
    f.engine.value = 73;
    f.engine.revision++;
    f.engine.failSave = true;
    const replacement = new SessionManager(f.options);
    f.replace(replacement);
    const resumed = await replacement.open(
      created.session.id,
      created.token,
      actor,
    );
    expect(resumed.native?.revision).toBe(f.engine.revision);
    expect(resumed.dirty).toBe(true);
    expect(resumed.checkpoint).toEqual(opened.checkpoint);
    f.engine.failSave = false;
    await vi.waitFor(
      async () => {
        expect(
          (await replacement.read(created.session.id, created.token)).dirty,
        ).toBe(false);
      },
      { timeout: 3000 },
    );
    expect(
      (await replacement.read(created.session.id, created.token)).checkpoint,
    ).not.toEqual(opened.checkpoint);
  });

  it("does not lose dirty state when geometry observes a revision before reconciliation", async () => {
    const { manager, engine } = await fixture();
    const created = await manager.create("owner", "geometry", "Geometry");
    const opened = await manager.open(created.session.id, created.token, actor);
    engine.revision++;
    await manager.geometry(
      created.session.id,
      created.token,
      opened.lease_token,
      engine.revision,
    );
    expect((await manager.read(created.session.id, created.token)).dirty).toBe(
      true,
    );
    const artifact = await manager.artifact(
      created.session.id,
      created.token,
      (await manager.read(created.session.id, created.token)).artifacts[0]!.id,
    );
    await artifact.handle.close();
  });

  it("exports toolpaths of a session slice once per revision and rejects them when stale", async () => {
    const { manager, engine } = await fixture();
    const created = await manager.create("owner", "toolpaths", "Toolpaths");
    const opened = await manager.open(created.session.id, created.token, actor);
    const native = opened.native!;
    const slice = await manager.command(
      created.session.id,
      created.token,
      opened.lease_token,
      "slice_start",
      { project_id: native.project_id, expected_revision: native.revision, plate_index: 0 },
    );
    const jobId = String(slice.result.job_id);
    await manager.command(created.session.id, created.token, opened.lease_token, "job_get", {
      job_id: jobId,
    });
    await expect(
      manager.toolpaths(created.session.id, created.token, opened.lease_token, native.revision, "job-missing"),
    ).rejects.toMatchObject({ code: "job_not_owned" });
    const first = await manager.toolpaths(
      created.session.id,
      created.token,
      opened.lease_token,
      native.revision,
      jobId,
    );
    const again = await manager.toolpaths(
      created.session.id,
      created.token,
      opened.lease_token,
      native.revision,
      jobId,
    );
    expect(again.artifact_id).toBe(first.artifact_id);
    const artifact = await manager.artifact(created.session.id, created.token, first.artifact_id);
    expect(artifact.kind).toBe("toolpaths");
    await artifact.handle.close();
    engine.revision++;
    await expect(
      manager.artifact(created.session.id, created.token, first.artifact_id),
    ).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("reclaims a dedicated worker after a reset occurred before metadata publication", async () => {
    const f = await fixture();
    const created = await f.manager.create("owner", "reset", "Reset recovery");
    await f.manager.open(created.session.id, created.token, actor);
    await f.manager.close();
    await f.engine.create();
    const replacement = new SessionManager(f.options);
    f.replace(replacement);
    await expect(
      replacement.open(created.session.id, created.token, actor),
    ).resolves.toMatchObject({ recovery_reason: "worker_restarted" });
  });

  it("accounts for prepared uploads and removes their files on release", async () => {
    const f = await fixture();
    const created = await f.manager.create("owner", "uploads", "Uploads");
    const opened = await f.manager.open(
      created.session.id,
      created.token,
      actor,
    );
    const upload = await f.manager.prepareUpload(
      created.session.id,
      created.token,
      opened.lease_token,
      { filename: "part.stl", bytes: 100, sha256: "a".repeat(64) },
    );
    await writeFile(
      join(f.options.workspaceRoot, "uploads", basename(upload.workspace_path)),
      "fixture",
    );
    await f.manager.finish(
      created.session.id,
      created.token,
      opened.lease_token,
      "release",
    );
    expect(await readdir(join(f.options.workspaceRoot, "uploads"))).toEqual([]);
  });

  it("rejects output creation at capacity before starting native work", async () => {
    const { manager, engine } = await fixture();
    const created = await manager.create(
      "owner",
      "capacity",
      "Output capacity",
    );
    const opened = await manager.open(created.session.id, created.token, actor);
    for (let index = 0; index < 32; index++) {
      const started = await manager.command(
        created.session.id,
        created.token,
        opened.lease_token,
        "project_save",
        {},
      );
      await manager.command(
        created.session.id,
        created.token,
        opened.lease_token,
        "job_get",
        { job_id: started.result.job_id },
      );
    }
    const count = engine.jobs.size;
    await expect(
      manager.command(
        created.session.id,
        created.token,
        opened.lease_token,
        "project_save",
        {},
      ),
    ).rejects.toMatchObject({ code: "session_output_limit" });
    expect(engine.jobs.size).toBe(count);
  });

  it("checkpoints a later mutation even when collecting an earlier output fails", async () => {
    const f = await fixture();
    const created = await f.manager.create(
      "owner",
      "job-errors",
      "Job isolation",
    );
    const opened = await f.manager.open(
      created.session.id,
      created.token,
      actor,
    );
    const output = await f.manager.command(
      created.session.id,
      created.token,
      opened.lease_token,
      "project_save",
      {},
    );
    f.engine.jobs.get(String(output.result.job_id))!.result = {
      path: "missing.3mf",
      bytes: 2000000,
    };
    f.engine.asyncArrange = true;
    await f.manager.command(
      created.session.id,
      created.token,
      opened.lease_token,
      "scene_arrange",
      {},
    );
    await vi.waitFor(
      async () => {
        expect(
          (await f.manager.read(created.session.id, created.token)).dirty,
        ).toBe(false);
      },
      { timeout: 3000 },
    );
    expect(
      (await f.manager.read(created.session.id, created.token)).checkpoint,
    ).not.toEqual(opened.checkpoint);
  });
  it("retains the native source and removes unpublished copies after a metadata commit failure", async () => {
    const f = await fixture();
    const created = await f.manager.create(
      "owner",
      "metadata",
      "Metadata failure",
    );
    const opened = await f.manager.open(
      created.session.id,
      created.token,
      actor,
    );
    const output = await f.manager.command(
      created.session.id,
      created.token,
      opened.lease_token,
      "project_save",
      {},
    );
    const directory = join(f.options.root, created.session.id);
    const previous = await readdir(directory);
    const save = vi
      .spyOn(SessionStore.prototype, "save")
      .mockImplementationOnce(() => {
        throw new Error("SQLite commit failed");
      });
    try {
      await expect(
        f.manager.command(
          created.session.id,
          created.token,
          opened.lease_token,
          "job_get",
          { job_id: output.result.job_id },
        ),
      ).rejects.toThrow("SQLite commit failed");
      expect(await readdir(directory)).toEqual(previous);
      expect(await readdir(f.options.outputRoot)).toHaveLength(1);
    } finally {
      save.mockRestore();
    }
    await f.manager.command(
      created.session.id,
      created.token,
      opened.lease_token,
      "job_get",
      { job_id: output.result.job_id },
    );
    expect(
      (await f.manager.read(created.session.id, created.token)).artifacts,
    ).toHaveLength(1);
    expect(await readdir(f.options.outputRoot)).toEqual([]);
  });
});
