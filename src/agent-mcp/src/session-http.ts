import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { BRIDGE_MAX_MESSAGE_SIZE } from "./types.js";
import { actorSchema, SessionError, sessionIdSchema } from "./session-store.js";
import type { SessionManager } from "./session-manager.js";
import { readGeometryManifest } from "./scene-geometry.js";
import { logApiFailure } from "./diagnostics.js";
import { openOrcaResource } from "./orca-resources.js";

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!header(request, "content-type")?.startsWith("application/json"))
    throw new SessionError("json_required", "Expected a JSON body", 415);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > BRIDGE_MAX_MESSAGE_SIZE)
      throw new SessionError(
        "request_too_large",
        "Session request exceeds the JSON limit",
        413,
      );
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    logApiFailure("session.http.read_json", error);
    throw new SessionError(
      "invalid_json",
      "Request body is not valid JSON",
      400,
      undefined,
      { cause: error },
    );
  }
}
function parse<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new SessionError(
      "invalid_params",
      "Invalid session parameters",
      400,
      result.error.issues,
    );
  return result.data;
}

export function createSessionHttp(manager: SessionManager) {
  const streams = new Set<ServerResponse>();
  return {
    close() {
      for (const response of streams) response.end();
    },
    async handle(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<void> {
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname === "/api/v1/sessions") {
          if (request.method === "POST") {
            const input = parse(
              z
                .object({
                  owner_id: z.string().min(1).max(128),
                  creation_key: z.string().min(1).max(128),
                  title: z.string().min(1).max(200),
                })
                .strict(),
              await body(request),
            );
            json(
              response,
              201,
              await manager.create(
                input.owner_id,
                input.creation_key,
                input.title,
              ),
            );
            return;
          }
          if (request.method === "GET") {
            const owner = parse(
              z.string().min(1).max(128),
              header(request, "x-agent-slicer-owner"),
            );
            json(response, 200, { sessions: await manager.list(owner) });
            return;
          }
        }
        const match = /^\/api\/v1\/sessions\/([^/]+)(?:\/(.*))?$/.exec(
          url.pathname,
        );
        if (!match) {
          json(response, 404, { error: { code: "not_found" } });
          return;
        }
        const id = parse(sessionIdSchema, match[1]);
        const action = match[2] ?? "";
        const token = header(request, "x-agent-slicer-session-token");
        const lease = header(request, "x-agent-slicer-lease-token") ?? "";
        if (request.method === "GET" && action === "") {
          json(response, 200, await manager.read(id, token));
          return;
        }
        if (request.method === "DELETE" && action === "") {
          await manager.remove(id, token);
          json(response, 200, { deleted: true });
          return;
        }
        if (request.method === "POST" && action === "open") {
          const input = parse(
            z.object({ actor: actorSchema }).strict(),
            await body(request),
          );
          json(response, 200, await manager.open(id, token, input.actor));
          return;
        }
        if (request.method === "POST" && action === "heartbeat") {
          json(response, 200, await manager.heartbeat(id, token, lease));
          return;
        }
        if (request.method === "POST" && action === "transfer") {
          const input = parse(
            z.object({ actor: actorSchema }).strict(),
            await body(request),
          );
          json(
            response,
            200,
            await manager.transfer(id, token, lease, input.actor),
          );
          return;
        }
        if (
          request.method === "POST" &&
          ["checkpoint", "release", "complete", "abandon"].includes(action)
        ) {
          json(
            response,
            200,
            await manager.finish(
              id,
              token,
              lease,
              action as "checkpoint" | "release" | "complete" | "abandon",
            ),
          );
          return;
        }
        const command = /^commands\/([a-z][a-z0-9_]*)$/.exec(action)?.[1];
        if (request.method === "POST" && command) {
          const input = parse(
            z.record(z.string(), z.unknown()),
            await body(request),
          );
          json(
            response,
            200,
            await manager.command(id, token, lease, command, input),
          );
          return;
        }
        if (request.method === "POST" && action === "uploads") {
          const input = parse(
            z
              .object({
                filename: z.string(),
                bytes: z.number().int().positive(),
                sha256: z.string(),
              })
              .strict(),
            await body(request),
          );
          json(
            response,
            201,
            await manager.prepareUpload(id, token, lease, input),
          );
          return;
        }
        const upload = /^uploads\/([^/]+)$/.exec(action)?.[1];
        if (request.method === "PUT" && upload) {
          json(
            response,
            201,
            await manager.receiveUpload(id, token, lease, upload, request),
          );
          return;
        }
        if (request.method === "POST" && action === "geometry") {
          const input = parse(
            z
              .object({ expected_revision: z.number().int().nonnegative() })
              .strict(),
            await body(request),
          );
          json(
            response,
            201,
            await manager.geometry(id, token, lease, input.expected_revision),
          );
          return;
        }
        const artifactMatch =
          /^artifacts\/([^/]+)(?:\/(manifest|binary))?$/.exec(action);
        if (request.method === "GET" && artifactMatch) {
          const artifactId = parse(z.uuid(), artifactMatch[1]);
          const artifact = await manager.artifact(id, token, artifactId);
          try {
            if (artifactMatch[2]) {
              if (artifact.kind !== "geometry")
                throw new SessionError(
                  "not_geometry",
                  "Artifact is not scene geometry",
                  400,
                );
              const geometry = await readGeometryManifest(
                artifact.handle,
                artifact.bytes,
              );
              if (artifactMatch[2] === "manifest") {
                json(response, 200, {
                  ...geometry.manifest,
                  session_id: id,
                  project_id: artifact.project_id,
                  revision: artifact.revision,
                  artifact_id: artifact.id,
                });
                return;
              }
              response.writeHead(200, {
                "content-type": "application/octet-stream",
                "content-length": geometry.binaryBytes,
                "cache-control": "no-store",
              });
              await pipeline(
                artifact.handle.createReadStream({
                  start: geometry.binaryOffset,
                  autoClose: false,
                }),
                response,
              );
              return;
            }
            response.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-length": artifact.bytes,
              "content-disposition": `attachment; filename="${artifact.filename}"`,
              "cache-control": "no-store",
            });
            await pipeline(
              artifact.handle.createReadStream({ autoClose: false }),
              response,
            );
            return;
          } finally {
            await artifact.handle.close();
          }
        }
        if (request.method === "GET" && action.startsWith("resources/")) {
          await manager.read(id, token);
          let relative: string;
          try {
            relative = decodeURIComponent(action.slice("resources/".length));
          } catch {
            throw new SessionError("resource_not_found", "Resource not found", 404);
          }
          const resource = await openOrcaResource(relative);
          try {
            response.writeHead(200, {
              "content-type": "image/png",
              "content-length": resource.bytes,
              "cache-control": "private, max-age=86400",
            });
            await pipeline(
              resource.handle.createReadStream({ autoClose: false }),
              response,
            );
          } finally {
            await resource.handle.close();
          }
          return;
        }
        if (request.method === "GET" && action === "events") {
          await manager.read(id, token);
          if (streams.size >= 16)
            throw new SessionError(
              "too_many_streams",
              "Too many session event connections",
              429,
            );
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
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
          const snapshot = async () => {
            try {
              const value = await manager.snapshot(
                id,
                token,
                url.searchParams.get("job_id") ?? undefined,
              );
              if (stopped) return;
              if (
                !response.write(
                  `event: snapshot\ndata: ${JSON.stringify(value)}\n\n`,
                )
              ) {
                response.end();
                return;
              }
              timer = setTimeout(() => {
                void snapshot();
              }, 1000);
            } catch (error) {
              logApiFailure(`session.${id}.events`, error);
              response.end();
            }
          };
          void snapshot();
          return;
        }
        json(response, 404, { error: { code: "not_found" } });
      } catch (error) {
        logApiFailure("session.http.request", error);
        if (!response.headersSent)
          json(response, error instanceof SessionError ? error.status : 500, {
            error:
              error instanceof SessionError
                ? {
                    code: error.code,
                    message: error.message,
                    details: error.details,
                  }
                : {
                    code: "session_service_error",
                    message: "Session service failed; inspect its logs",
                  },
          });
        else response.end();
      }
    },
  };
}
