import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SessionError } from "../../src/session-store.js";
import type { NativeJob, SessionEngine } from "../../src/session-engine.js";

export class TestNativeEngine implements SessionEngine {
  project: string | null = null;
  revision = 0;
  next = 0;
  value = 0;
  failSave = false;
  asyncArrange = false;
  jobs = new Map<string, NativeJob>();
  constructor(private readonly outputs: string) {}
  async status() {
    return {
      ready: true,
      project_id: this.project,
      revision: this.revision,
      capabilities: ["project_restore", "scene_export"],
    };
  }
  async create() {
    this.project = `project-${++this.next}`;
    this.value = 0;
    return { project_id: this.project, revision: ++this.revision };
  }
  async restore(path: string, revision: number) {
    if (revision !== this.revision) throw new Error("stale restore");
    const saved = JSON.parse(await readFile(path, "utf8"));
    const result = await this.create();
    this.value = saved.value;
    return result;
  }
  async command(name: string, params: Record<string, unknown>) {
    if (name === "scene_arrange" && this.asyncArrange) {
      this.revision++;
      this.value++;
      const job_id = `job-${++this.next}`;
      this.jobs.set(job_id, {
        job_id,
        type: name,
        state: "succeeded",
        project_id: this.project,
        source_revision: this.revision - 1,
        revision: this.revision,
        result: {},
      });
      return { job_id, state: "running" };
    }
    if (name === "settings_apply") {
      if (params.expected_revision !== this.revision)
        throw new SessionError("revision_conflict", "Stale revision");
      this.value = Number(params.value);
      this.revision++;
      return { project_id: this.project, revision: this.revision };
    }
    if (name === "project_save" || name === "scene_export") {
      if (this.failSave) throw new Error("disk write failed");
      const path = join(this.outputs, String(params.output_path));
      await writeFile(path, JSON.stringify({ value: this.value }));
      const job_id = `job-${++this.next}`;
      this.jobs.set(job_id, {
        job_id,
        type: name,
        state: "succeeded",
        project_id: this.project,
        source_revision: this.revision,
        revision: this.revision,
        result: { path, bytes: (await readFile(path)).length },
      });
      return { job_id, state: "running" };
    }
    if (name === "job_get") return { ...this.jobs.get(String(params.job_id)) };
    return {
      project_id: this.project,
      revision: this.revision,
      value: this.value,
    };
  }
  async wait(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("unknown test job");
    return job;
  }
}
