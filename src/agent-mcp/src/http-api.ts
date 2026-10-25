import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { createPublicAgentCommands, type AgentToolDependencies } from "./tool-contract.js";
import { logApiFailure } from "./diagnostics.js";

const MAX_COMMAND_BYTES = 1024 * 1024;
const SNAPSHOT_INTERVAL_MS = 1000;
const MAX_EVENT_STREAMS = 16;
const jobIdSchema = z.string().min(1).max(128);

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

export function createEditorApi(dependencies: AgentToolDependencies) {
  const commands = createPublicAgentCommands(dependencies);
  const streams = new Set<ServerResponse>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname === "/api/v1/capabilities" && request.method === "GET") {
      json(response, 200, {
        api_version: 1,
        build_revision: process.env.AGENT_SLICER_BUILD_REVISION ?? "development",
        session_model: "one_active_project_per_worker",
        events: "snapshot",
        sessions: { version: 1, storage: "sqlite_native_3mf", editing: "exclusive_capability_lease", worker_role: "dedicated_editor" },
        geometry: { format: "ASGEOM01", units: "millimeter", up_axis: "Z", matrix_order: "column-major" },
        commands: Object.fromEntries(Object.entries(commands).map(([name, command]) => [name, {
          input: z.toJSONSchema(command.inputSchema),
        }])),
      });
      return;
    }
    if (url.pathname === "/api/v1/events" && request.method === "GET") {
      const parsedJob = jobIdSchema.optional().safeParse(url.searchParams.get("job_id") ?? undefined);
      if (!parsedJob.success) {
        json(response, 400, { error: { code: "invalid_job_id" } });
        return;
      }
      if (streams.size >= MAX_EVENT_STREAMS) {
        json(response, 429, { error: { code: "too_many_streams" } });
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream", "cache-control": "no-store",
        "x-accel-buffering": "no", connection: "keep-alive",
      });
      response.write("retry: 2000\n\n");
      streams.add(response);
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      response.once("close", () => {
        stopped = true;
        clearTimeout(timer);
        streams.delete(response);
      });
      const snapshot = async (): Promise<void> => {
        try {
          const status = await commands.slicer_status.execute({});
          const job = parsedJob.data === undefined ? undefined :
            await commands.job_get.execute({ job_id: parsedJob.data });
          if (stopped) return;
          const event = status.isError || job?.isError ? "backend_error" : "snapshot";
          const value = { status: status.structuredContent, ...(job ? { job: job.structuredContent } : {}) };
          if (!response.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`)) {
            response.end();
            return;
          }
        } catch (error) {
          logApiFailure("editor.events.snapshot", error);
          if (!stopped) response.end();
          return;
        }
        if (!stopped) timer = setTimeout(() => { void snapshot(); }, SNAPSHOT_INTERVAL_MS);
      };
      void snapshot();
      return;
    }
    const match = /^\/api\/v1\/commands\/([a-z][a-z0-9_]*)$/.exec(url.pathname);
    const name = match?.[1];
    if (!name || !Object.hasOwn(commands, name)) {
      json(response, 404, { error: { code: "not_found" } });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      json(response, 405, { error: { code: "method_not_allowed" } });
      return;
    }
    if (!request.headers["content-type"]?.startsWith("application/json")) {
      json(response, 415, { error: { code: "json_required" } });
      return;
    }
    const command = commands[name as keyof typeof commands];
    let params: unknown;
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_COMMAND_BYTES) {
          json(response, 413, { error: { code: "request_too_large" } });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      params = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      logApiFailure(`editor.${name}.read_json`, error);
      json(response, 400, { error: { code: "invalid_json" } });
      return;
    }
    const parsed = command.inputSchema.safeParse(params);
    if (!parsed.success) {
      // Input values can contain model paths/settings. Log issues without their values.
      process.stderr.write(`${JSON.stringify({ level: "warn", operation: `editor.${name}.validate`, issues: parsed.error.issues.map(({ code, path }) => ({ code, path })) })}\n`);
      json(response, 400, { error: { code: "invalid_params", issues: parsed.error.issues } });
      return;
    }
    const result = await command.execute(parsed.data);
    const payload = result.structuredContent;
    const failure = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
    const code = failure.success ? failure.data.error.code : undefined;
    const status = !result.isError ? 200 : code === "revision_conflict" || code === "project_mismatch" ? 409 :
      code === "not_found" ? 404 : code === "mcp_adapter_error" ? 502 : 422;
    // Render commands also return PNG image content blocks; preserve them for browsers.
    json(response, status, result);
  }

  return {
    handle,
    close() { for (const response of streams) response.end(); },
  };
}
