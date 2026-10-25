import {
  createAgentCommands,
  type AgentToolDependencies,
} from "./tool-contract.js";
import { SessionError } from "./session-store.js";
import { z } from "zod";

export const nativeProjectSchema = z.object({
  project_id: z.string(),
  revision: z.number().int(),
});
export const nativeSessionStatusSchema = z.object({
  ready: z.boolean(),
  project_id: z.string().nullable(),
  revision: z.number().int(),
  capabilities: z.array(z.string()),
});
export const nativeJobSchema = z.object({
  job_id: z.string(),
  type: z.string(),
  state: z.string(),
  project_id: z.string().nullable(),
  source_revision: z.number().nullable(),
  revision: z.number(),
  result: z.unknown(),
  error: z.unknown().optional(),
});
export type NativeProject = z.infer<typeof nativeProjectSchema>;
export type NativeJob = z.infer<typeof nativeJobSchema>;

export interface SessionEngine {
  status(): Promise<z.infer<typeof nativeSessionStatusSchema>>;
  create(): Promise<NativeProject>;
  restore(path: string, revision: number): Promise<NativeProject>;
  command(
    name: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  wait(jobId: string): Promise<NativeJob>;
}

export class NativeSessionEngine implements SessionEngine {
  private readonly commands;
  constructor(
    dependencies: AgentToolDependencies,
    private readonly timeoutMs: number,
  ) {
    this.commands = createAgentCommands(dependencies);
  }
  async command(
    name: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!Object.hasOwn(this.commands, name))
      throw new SessionError("unknown_command", "Unknown session command", 404);
    const command = this.commands[name as keyof typeof this.commands];
    const parsed = command.inputSchema.safeParse(params);
    if (!parsed.success)
      throw new SessionError(
        "invalid_params",
        "Invalid command parameters",
        400,
        parsed.error.issues,
      );
    const result = await command.execute(parsed.data);
    const payload = z
      .record(z.string(), z.unknown())
      .parse(result.structuredContent);
    if (result.isError) {
      const error = z
        .object({
          code: z.string(),
          message: z.string(),
          details: z.unknown().optional(),
        })
        .parse(payload.error);
      throw new SessionError(
        error.code,
        error.message,
        error.code === "revision_conflict" ? 409 : 422,
        error.details,
      );
    }
    // Structured render metadata deliberately excludes image content blocks.
    // Session callers download registered files; mesh data never enters bridge JSON.
    return payload;
  }
  async status() {
    return nativeSessionStatusSchema.parse(
      await this.command("slicer_status", {}),
    );
  }
  async create() {
    return nativeProjectSchema.parse(await this.command("project_create", {}));
  }
  async restore(path: string, revision: number) {
    return nativeProjectSchema.parse(
      await this.command("project_restore", {
        path,
        expected_revision: revision,
      }),
    );
  }
  async wait(jobId: string): Promise<NativeJob> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const job = nativeJobSchema.parse(
        await this.command("job_get", { job_id: jobId }),
      );
      if (job.state === "succeeded") return job;
      if (job.state === "failed" || job.state === "cancelled")
        throw new SessionError(
          "native_job_failed",
          "Native session operation did not succeed",
          422,
          job,
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new SessionError(
      "native_job_timeout",
      "Native job is still unresolved; inspect the job before retrying",
      504,
      { job_id: jobId },
    );
  }
}
