import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { BridgeError } from "../src/bridge-client.js";
import type { AgentMcpConfig } from "../src/config.js";
import { readInternalPng, unlinkInternalPng } from "../src/images.js";
import { createAgentHttpServer, type AgentHttpServer } from "../src/server.js";
import { toolNames, type ToolDependencies } from "../src/tool-contract.js";
import { pngFixture } from "./png-fixture.js";

const PNG = pngFixture(256, 256);
const TOOLPATH_LEGEND = [
  ["inner_wall", "Inner wall", "#FFE64D", "extrusion"],
  ["outer_wall", "Outer wall", "#FF7D38", "extrusion"],
  ["overhang_wall", "Overhang wall", "#1F1FFF", "extrusion"],
  ["sparse_infill", "Sparse infill", "#B03029", "extrusion"],
  ["internal_solid_infill", "Internal solid infill", "#9654CC", "extrusion"],
  ["top_surface", "Top surface", "#F04040", "extrusion"],
  ["bridge", "Bridge", "#4D80BA", "extrusion"],
  ["gap_infill", "Gap infill", "#FFFFFF", "extrusion"],
  ["custom", "Custom", "#5ED194", "extrusion"],
  ["bottom_surface", "Bottom surface", "#665CC7", "extrusion"],
  ["internal_bridge", "Internal bridge", "#4D80BA", "extrusion"],
  ["brim", "Brim", "#003B6E", "extrusion"],
  ["seam", "Seam", "#E6E6E6", "marker"],
].map(([feature, label, color, kind]) => ({ feature, label, color, kind }));
const EXCLUDED_TOOLPATH_MOVES = [
  "travel", "wipe", "retract", "unretract", "tool_change",
  "filament_change", "pause", "custom_gcode",
];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function startMcp(options: {
  bearerToken?: string;
  bridgeTimeoutMs?: number;
  renderPng?: Buffer;
  renderPngs?: readonly Buffer[];
  renderViews?: string[];
  renderMetadataDimensions?:
    | { width: number; height: number }
    | ((index: number) => { width: number; height: number });
  beforeSceneRenderResponse?: (paths: readonly string[]) => Promise<void>;
  onDesktopCapture?: () => Promise<void> | void;
  readPng?: ToolDependencies["readPng"];
  removePng?: ToolDependencies["removePng"];
  maxUploadBytes?: number;
  uploadTtlMs?: number;
  bridgeCall?: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;
} = {}): Promise<{
  client: Client;
  calls: Array<[string, Record<string, unknown>]>;
  endpoint: URL;
  renderPaths: string[];
  workspaceRoot: string;
  outputRoot: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "agent-mcp-http-"));
  const renderRoot = join(directory, "mcp");
  const desktopRoot = join(directory, "desktop");
  const workspaceRoot = join(directory, "workspace");
  const outputRoot = join(directory, "outputs");
  await mkdir(renderRoot);
  await mkdir(desktopRoot);
  await mkdir(outputRoot);
  const renderViews = options.renderViews ?? ["iso"];
  const renderPaths = renderViews.map((_, index) => join(renderRoot, `render-${index}.png`));
  const renderPng = options.renderPng ?? PNG;
  const renderPngs = options.renderPngs ?? renderPaths.map(() => renderPng);
  await Promise.all(renderPaths.map((path, index) => writeFile(path, renderPngs[index]!)));
  const calls: Array<[string, Record<string, unknown>]> = [];

  const dependencies: ToolDependencies = {
    bridge: {
      async call(method, params = {}) {
        calls.push([method, params]);
        if (options.bridgeCall !== undefined) {
          return options.bridgeCall(method, params);
        }
        if (method === "slicer_status") {
          return {
            ready: true,
            protocol_version: 2,
            project_id: null,
            revision: 0,
            job_count: 0,
            capabilities: ["project_foundation"],
          };
        }
        if (method === "project_create") {
          return { project_id: "project-1", revision: 1 };
        }
        if (method === "scene_render") {
          await options.beforeSceneRenderResponse?.(renderPaths);
          return {
            project_id: "project-1",
            revision: 2,
            images: renderViews.map((view, index) => ({
              path: renderPaths[index],
              view,
              width: typeof options.renderMetadataDimensions === "function"
                ? options.renderMetadataDimensions(index).width
                : options.renderMetadataDimensions?.width ?? 256,
              height: typeof options.renderMetadataDimensions === "function"
                ? options.renderMetadataDimensions(index).height
                : options.renderMetadataDimensions?.height ?? 256,
              mime_type: "image/png",
              bytes: renderPngs[index]!.length,
            })),
          };
        }
        if (method === "toolpath_render") {
          await options.beforeSceneRenderResponse?.(renderPaths);
          return {
            project_id: "project-1",
            revision: 2,
            slice_job_id: "job-slice",
            plate_index: 0,
            available_layer_range: { start: 0, end: 120 },
            rendered_layer_range: params.layer_range ?? { start: 0, end: 120 },
            legend: TOOLPATH_LEGEND,
            excluded_move_types: EXCLUDED_TOOLPATH_MOVES,
            images: renderViews.map((view, index) => ({
              path: renderPaths[index],
              view,
              width: typeof options.renderMetadataDimensions === "function"
                ? options.renderMetadataDimensions(index).width
                : options.renderMetadataDimensions?.width ?? 256,
              height: typeof options.renderMetadataDimensions === "function"
                ? options.renderMetadataDimensions(index).height
                : options.renderMetadataDimensions?.height ?? 256,
              mime_type: "image/png",
              bytes: renderPngs[index]!.length,
              segment_count: 1234,
              seam_count: 56,
            })),
          };
        }
        if (method === "project_get") {
          return { project_id: "project-1", revision: 2 };
        }
        if (method === "job_get") {
          return {
            job_id: "job-1",
            type: "arrange",
            state: "running",
            progress: 0.5,
            project_id: "project-1",
            source_revision: 2,
            warnings: [],
            metadata: {
              config_snapshot: {
                schema_version: 2,
                revision: 2,
                presets: {
                  printer: "CoreXY",
                  process: "0.20mm Quality",
                  filaments: ["Generic PLA"],
                },
                settings: {
                  layer_height: "0.2",
                  wall_loops: "2",
                },
                overrides: [],
                redacted_keys: ["global/post_process", "global/printhost_password"],
                sha256: "a".repeat(64),
                bytes: 2048,
              },
            },
            result: null,
            error: null,
            revision: 2,
          };
        }
        if (method === "model_import") {
          return { job_id: "import-1", state: "running" };
        }
        if (method === "scene_get") {
          return { project_id: "project-1", revision: 2, objects: [], plates: [] };
        }
        if (method === "object_auto_orient" || method === "scene_arrange") {
          return { job_id: "job-1", state: "running" };
        }
        if (method === "slice_start" || method === "gcode_export" || method === "project_save") {
          return { job_id: `${method}-1`, state: "running" };
        }
        if (method === "presets_list") {
          return {
            project_id: "project-1",
            revision: 2,
            selected: {
              printer: "CoreXY",
              process: "0.20mm Quality",
              filaments: ["Generic PLA"],
            },
            presets: [
              { scope: "printer", name: "CoreXY", selected: true, compatible: true },
              {
                scope: "process",
                name: "0.20mm Quality",
                selected: true,
                compatible: true,
              },
              {
                scope: "filament",
                name: "Generic PLA",
                selected: true,
                compatible: true,
              },
            ],
          };
        }
        if (method === "presets_select") {
          return {
            project_id: "project-1",
            revision: 3,
            selected: {
              printer: "CoreXY",
              process: "0.16mm Quality",
              filaments: ["Generic PLA"],
            },
          };
        }
        if (method === "settings_describe") {
          return {
            project_id: "project-1",
            revision: 3,
            items: [
              {
                key: "layer_height",
                scope: "process",
                label: "Layer height",
                description: "Height of each printed layer.",
                type: "float",
                nullable: false,
                read_only: false,
                unit: "mm",
                min: 0.01,
                max: 2,
                max_literal: null,
                enum_values: null,
              },
            ],
            next_cursor: "page-2",
          };
        }
        if (method === "settings_get") {
          return {
            project_id: "project-1",
            revision: 3,
            values: [
              {
                key: "layer_height",
                scope: "process",
                value: 0.2,
                unit: "mm",
              },
            ],
          };
        }
        if (method === "settings_apply") {
          const dryRun = params.dry_run === true;
          return {
            project_id: "project-1",
            revision: dryRun ? 3 : 4,
            dry_run: dryRun,
            applied: params.changes,
          };
        }
        return { project_id: "project-1", revision: 2 };
      },
    },
    desktopCapture: {
      async capture(filename) {
        await options.onDesktopCapture?.();
        return {
          data: PNG,
          path: join(desktopRoot, filename),
        };
      },
    },
    screenshotRoots: [renderRoot],
    desktopScreenshotRoot: desktopRoot,
    maxImageBytes: 1024,
    ...(options.readPng ? { readPng: options.readPng } : {}),
    ...(options.removePng ? { removePng: options.removePng } : {}),
  };
  const config: AgentMcpConfig = {
    bindHost: "127.0.0.1",
    port: 0,
    bridgeSocketPath: join(directory, "unused.sock"),
    bridgeTimeoutMs: options.bridgeTimeoutMs ?? 1000,
    screenshotRoots: [renderRoot],
    desktopCaptureExecutable: "/unused",
    desktopScreenshotRoot: desktopRoot,
    maxImageBytes: 1024,
    workspaceRoot,
    outputRoot,
    maxUploadBytes: options.maxUploadBytes ?? 1024 * 1024,
    uploadTtlMs: options.uploadTtlMs ?? 60_000,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: ["127.0.0.1"],
    ...(options.bearerToken ? { bearerToken: options.bearerToken } : {}),
  };
  const http: AgentHttpServer = createAgentHttpServer(config, dependencies);
  await new Promise<void>((resolve, reject) => {
    http.server.once("error", reject);
    http.server.listen(0, "127.0.0.1", resolve);
  });
  const address = http.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test MCP server did not bind a TCP port");
  }

  const client = new Client(
    { name: "agent-slicer-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    ...(options.bearerToken
      ? { requestInit: { headers: { authorization: `Bearer ${options.bearerToken}` } } }
      : {}),
  });
  await client.connect(transport);
  cleanups.push(
    async () => client.close(),
    async () => http.close(),
    () => rm(directory, { recursive: true, force: true }),
  );
  return { client, calls, endpoint, renderPaths, workspaceRoot, outputRoot };
}

async function rawRequest(
  endpoint: URL,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
  requestBody?: Buffer,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  const url = new URL(path, endpoint);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: text.length === 0 ? null : JSON.parse(text),
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end(requestBody);
  });
}

async function rawBufferRequest(
  endpoint: URL,
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const url = new URL(path, endpoint);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(url, { method, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

describe("Streamable HTTP MCP server", () => {
  it("lists and downloads outputs through the MCP bearer-auth boundary", async () => {
    const { endpoint, outputRoot } = await startMcp({ bearerToken: "deployment-secret" });
    await writeFile(join(outputRoot, "part.gcode"), "G1 X1\n");
    await writeFile(join(outputRoot, "project.3mf"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    await writeFile(join(outputRoot, "ignored.txt"), "not downloadable");
    await mkdir(join(outputRoot, "nested.gcode"));
    await symlink(join(outputRoot, "part.gcode"), join(outputRoot, "linked.gcode"));

    await expect(rawRequest(endpoint, "/outputs/")).resolves.toMatchObject({
      status: 401,
      body: { error: "unauthorized" },
    });
    await expect(
      rawRequest(endpoint, "/outputs/", "GET", { authorization: "Bearer deployment-secret" }),
    ).resolves.toMatchObject({
      status: 200,
      body: { outputs: ["/outputs/part.gcode", "/outputs/project.3mf"] },
    });

    const downloaded = await rawBufferRequest(endpoint, "/outputs/part.gcode", "GET", {
      authorization: "Bearer deployment-secret",
    });
    expect(downloaded).toMatchObject({
      status: 200,
      headers: {
        "cache-control": "no-store",
        "content-disposition": "attachment; filename*=UTF-8''part.gcode",
        "content-length": "6",
        "content-type": "application/octet-stream",
        "x-content-type-options": "nosniff",
      },
    });
    expect(downloaded.body.toString("utf8")).toBe("G1 X1\n");

    const head = await rawBufferRequest(endpoint, "/outputs/project.3mf", "HEAD", {
      authorization: "Bearer deployment-secret",
    });
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe("4");
    expect(head.body).toHaveLength(0);

    for (const path of [
      "/outputs/ignored.txt",
      "/outputs/nested.gcode",
      "/outputs/linked.gcode",
      "/outputs/nested%2Fescape.gcode",
      "/outputs/%E0%A4%A.gcode",
    ]) {
      await expect(
        rawRequest(endpoint, path, "GET", { authorization: "Bearer deployment-secret" }),
      ).resolves.toMatchObject({ status: 404, body: { error: "not_found" } });
    }

    const wrongMethod = await rawRequest(endpoint, "/outputs/part.gcode", "POST", {
      authorization: "Bearer deployment-secret",
    });
    expect(wrongMethod).toMatchObject({ status: 405, body: { error: "method_not_allowed" } });
    expect(wrongMethod.headers.allow).toBe("GET, HEAD");
  });

  it("reports unauthenticated liveness without calling the bridge", async () => {
    const { endpoint, calls } = await startMcp({ bearerToken: "deployment-secret" });

    const response = await rawRequest(endpoint, "/livez");

    expect(response).toMatchObject({
      status: 200,
      body: { ok: true, service: "agent-slicer-mcp" },
    });
    expect(calls).toEqual([]);
  });

  it("reports ready only when the native bridge explicitly returns ready true", async () => {
    const { endpoint, calls } = await startMcp({ bearerToken: "deployment-secret" });

    await expect(rawRequest(endpoint, "/readyz")).resolves.toMatchObject({
      status: 200,
      body: { ok: true, service: "agent-slicer-mcp", ready: true },
    });
    await expect(rawRequest(endpoint, "/healthz")).resolves.toMatchObject({
      status: 200,
      body: { ok: true, service: "agent-slicer-mcp", ready: true },
    });
    expect(calls).toEqual([
      ["slicer_status", {}],
      ["slicer_status", {}],
    ]);
  });

  it("returns a safe 503 when the bridge is not ready", async () => {
    const { endpoint } = await startMcp({
      bridgeCall: () => ({
        ready: false,
        socket_path: "/run/agent-slicer/private.sock",
        token: "must-not-leak",
      }),
    });

    const response = await rawRequest(endpoint, "/readyz");

    expect(response).toMatchObject({
      status: 503,
      body: {
        ok: false,
        service: "agent-slicer-mcp",
        ready: false,
        reason: "not_ready",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("private.sock");
    expect(JSON.stringify(response.body)).not.toContain("must-not-leak");
  });

  it("returns a safe 503 for bridge errors and readiness timeouts", async () => {
    const secret = "bridge-secret-that-must-not-leak";
    const failed = await startMcp({
      bridgeCall: () => {
        throw new Error(secret);
      },
    });
    const failure = await rawRequest(failed.endpoint, "/readyz");
    expect(failure).toMatchObject({
      status: 503,
      body: {
        ok: false,
        service: "agent-slicer-mcp",
        ready: false,
        reason: "bridge_unavailable",
      },
    });
    expect(JSON.stringify(failure.body)).not.toContain(secret);

    const timedOut = await startMcp({
      bridgeTimeoutMs: 20,
      bridgeCall: () => new Promise(() => undefined),
    });
    await expect(rawRequest(timedOut.endpoint, "/healthz")).resolves.toMatchObject({
      status: 503,
      body: {
        ok: false,
        service: "agent-slicer-mcp",
        ready: false,
        reason: "bridge_unavailable",
      },
    });
    await expect(rawRequest(timedOut.endpoint, "/readyz")).resolves.toMatchObject({
      status: 503,
      body: {
        ok: false,
        service: "agent-slicer-mcp",
        ready: false,
        reason: "bridge_unavailable",
      },
    });
    expect(timedOut.calls).toEqual([["slicer_status", {}]]);
  });

  it("allows only GET on health endpoints", async () => {
    const { endpoint, calls } = await startMcp();

    for (const path of ["/livez", "/readyz", "/healthz"]) {
      const response = await rawRequest(endpoint, path, "POST");
      expect(response).toMatchObject({
        status: 405,
        body: { error: "method_not_allowed" },
      });
      expect(response.headers.allow).toBe("GET");
    }
    expect(calls).toEqual([]);
  });

  it("lists schemas and maps tools through a fresh per-request server", async () => {
    const { client, calls } = await startMcp();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(toolNames);
    expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    expect(listed.tools.every((tool) => tool.outputSchema?.type === "object")).toBe(true);
    expect(
      listed.tools.find((tool) => tool.name === "settings_describe")?.description,
    ).toContain("unit");
    expect(
      listed.tools.find((tool) => tool.name === "settings_apply")?.description,
    ).toContain("printer, process, or filament");
    expect(
      listed.tools.find((tool) => tool.name === "upload_prepare")?.description,
    ).toContain("agentslicer://docs/upload");
    expect(
      listed.tools.find((tool) => tool.name === "scene_render")?.description,
    ).toContain("inline MCP image content");
    expect(
      listed.tools.find((tool) => tool.name === "toolpath_render")?.description,
    ).toContain("excludes travel");
    expect(
      listed.tools.find((tool) => tool.name === "desktop_capture")?.description,
    ).toContain("not an HTTP URL");

    const created = await client.callTool({ name: "project_create", arguments: {} });
    expect(created.structuredContent).toEqual({ project_id: "project-1", revision: 1 });
    expect(calls).toContainEqual(["project_create", {}]);
  });

  it("advertises the upload workflow as an MCP resource", async () => {
    const { client } = await startMcp({ maxUploadBytes: 4096, uploadTtlMs: 12_345 });

    const listed = await client.listResources();
    expect(listed.resources).toContainEqual(expect.objectContaining({
      uri: "agentslicer://docs/upload",
      name: "upload-guide",
      mimeType: "text/markdown",
    }));

    const resource = await client.readResource({ uri: "agentslicer://docs/upload" });
    expect(resource.contents).toHaveLength(1);
    expect(resource.contents[0]).toMatchObject({
      uri: "agentslicer://docs/upload",
      mimeType: "text/markdown",
    });
    expect(resource.contents[0]).toHaveProperty("text");
    const text = "text" in resource.contents[0]! ? resource.contents[0].text : "";
    expect(text).toContain("upload_prepare");
    expect(text).toContain("/uploads");
    expect(text).toContain("4096 bytes");
    expect(text).toContain("12345 milliseconds");
  });

  it("uploads verified bytes once and imports the returned workspace path", async () => {
    const token = "deployment-secret";
    const { client, calls, endpoint, workspaceRoot } = await startMcp({ bearerToken: token });
    const model = Buffer.from("solid upload-test\nendsolid upload-test\n");
    const sha256 = createHash("sha256").update(model).digest("hex");
    const prepared = await client.callTool({
      name: "upload_prepare",
      arguments: { filename: "upload-test.stl", bytes: model.length, sha256 },
    });
    expect(prepared.isError).not.toBe(true);
    expect(prepared.structuredContent).toMatchObject({
      method: "PUT",
      filename: "upload-test.stl",
      bytes: model.length,
      sha256,
      content_type: "application/octet-stream",
      upload_path: expect.stringMatching(/^\/uploads\/.+$/),
      workspace_path: expect.stringMatching(/^\/workspace\/uploads\/.+\.stl$/),
    });
    const preparedContent = prepared.structuredContent as Record<string, unknown>;
    const uploadPath = String(preparedContent.upload_path);
    const workspacePath = String(preparedContent.workspace_path);
    const uploadHeaders = {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "content-length": String(model.length),
    };

    const unauthorized = await rawRequest(
      endpoint,
      uploadPath,
      "PUT",
      { ...uploadHeaders, authorization: "Bearer wrong-secret" },
      model,
    );
    expect(unauthorized).toMatchObject({ status: 401, body: { error: "unauthorized" } });

    const rejectedHost = await rawRequest(
      endpoint,
      uploadPath,
      "PUT",
      { ...uploadHeaders, host: "attacker.example" },
      model,
    );
    expect(rejectedHost.status).toBe(403);
    const rejectedOrigin = await rawRequest(
      endpoint,
      uploadPath,
      "PUT",
      { ...uploadHeaders, origin: "https://attacker.example" },
      model,
    );
    expect(rejectedOrigin.status).toBe(403);

    const uploaded = await rawRequest(endpoint, uploadPath, "PUT", uploadHeaders, model);
    expect(uploaded).toMatchObject({
      status: 201,
      body: { ok: true, workspace_path: workspacePath, bytes: model.length, sha256 },
    });
    await expect(
      readFile(join(workspaceRoot, "uploads", basename(workspacePath))),
    ).resolves.toEqual(model);

    const reused = await rawRequest(endpoint, uploadPath, "PUT", uploadHeaders, model);
    expect(reused).toMatchObject({ status: 404, body: { error: "upload_not_found" } });

    await client.callTool({ name: "project_create", arguments: {} });
    await client.callTool({
      name: "model_import",
      arguments: {
        project_id: "project-1",
        expected_revision: 1,
        path: workspacePath,
      },
    });
    expect(calls).toContainEqual([
      "model_import",
      { project_id: "project-1", expected_revision: 1, path: workspacePath },
    ]);
  });

  it("rejects checksum mismatches without publishing partial uploads", async () => {
    const token = "deployment-secret";
    const { client, endpoint, workspaceRoot } = await startMcp({ bearerToken: token });
    const expected = Buffer.from("expected model bytes");
    const actual = Buffer.from("different model byte");
    expect(actual.length).toBe(expected.length);
    const prepared = await client.callTool({
      name: "upload_prepare",
      arguments: {
        filename: "checksum.obj",
        bytes: expected.length,
        sha256: createHash("sha256").update(expected).digest("hex"),
      },
    });
    const preparedContent = prepared.structuredContent as Record<string, unknown>;
    const response = await rawRequest(
      endpoint,
      String(preparedContent.upload_path),
      "PUT",
      {
        authorization: `Bearer ${token}`,
        "content-type": "application/octet-stream",
        "content-length": String(actual.length),
      },
      actual,
    );

    expect(response).toMatchObject({ status: 422, body: { error: "checksum_mismatch" } });
    await expect(readdir(join(workspaceRoot, "uploads"))).resolves.toEqual([]);
  });

  it("enforces configured upload limits before issuing a ticket", async () => {
    const { client } = await startMcp({ maxUploadBytes: 4 });
    const prepared = await client.callTool({
      name: "upload_prepare",
      arguments: {
        filename: "too-large.3mf",
        bytes: 5,
        sha256: "a".repeat(64),
      },
    });

    expect(prepared.isError).toBe(true);
    expect(prepared.structuredContent).toMatchObject({
      error: { code: "upload_too_large", message: expect.stringContaining("4 byte") },
    });
  });

  it("returns native renders as structured metadata plus PNG image content", async () => {
    const { client, renderPaths } = await startMcp();
    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        expected_revision: 1,
        views: ["iso"],
        width: 256,
        height: 256,
      },
    });
    expect(rendered.structuredContent).toMatchObject({
      project_id: "project-1",
      revision: 2,
      images: [{ view: "iso", bytes: PNG.length, mime_type: "image/png" }],
    });
    expect(rendered.content).toContainEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
    await expect(access(renderPaths[0]!)).rejects.toThrow();
  });

  it("returns sliced toolpaths with Orca feature colors and excluded motions", async () => {
    const { client, calls, renderPaths } = await startMcp({ renderViews: ["topfront"] });
    const rendered = await client.callTool({
      name: "toolpath_render",
      arguments: {
        project_id: "project-1",
        expected_revision: 2,
        slice_job_id: "job-slice",
        views: ["top_front"],
        width: 256,
        height: 256,
        layer_range: { start: 10, end: 20 },
      },
    });

    expect(rendered.isError).not.toBe(true);
    expect(rendered.structuredContent).toMatchObject({
      project_id: "project-1",
      revision: 2,
      slice_job_id: "job-slice",
      plate_index: 0,
      available_layer_range: { start: 0, end: 120 },
      rendered_layer_range: { start: 10, end: 20 },
      legend: expect.arrayContaining([
        { feature: "outer_wall", label: "Outer wall", color: "#FF7D38", kind: "extrusion" },
        { feature: "seam", label: "Seam", color: "#E6E6E6", kind: "marker" },
      ]),
      excluded_move_types: EXCLUDED_TOOLPATH_MOVES,
      images: [{
        view: "top_front",
        width: 256,
        height: 256,
        segment_count: 1234,
        seam_count: 56,
      }],
    });
    expect(rendered.content).toContainEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
    expect(calls).toContainEqual([
      "toolpath_render",
      {
        project_id: "project-1",
        expected_revision: 2,
        slice_job_id: "job-slice",
        views: ["topfront"],
        width: 256,
        height: 256,
        layer_range: { start: 10, end: 20 },
      },
    ]);
    await expect(access(renderPaths[0]!)).rejects.toThrow();
  });

  it("returns the public top_front view name after native topfront rendering", async () => {
    const { client, calls } = await startMcp({ renderViews: ["topfront"] });
    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        views: ["top_front"],
        width: 256,
        height: 256,
      },
    });

    expect(rendered.isError).not.toBe(true);
    expect(rendered.structuredContent).toMatchObject({
      images: [{ view: "top_front" }],
    });
    expect(calls).toContainEqual([
      "scene_render",
      {
        project_id: "project-1",
        views: ["topfront"],
        width: 256,
        height: 256,
      },
    ]);
  });

  it("waits for delayed validated renders before cleaning after a fast validation failure", async () => {
    const events: string[] = [];
    const cleanupPaths: string[] = [];
    const { client, renderPaths } = await startMcp({
      renderViews: ["iso", "top"],
      renderPngs: [pngFixture(1, 1), PNG],
      async readPng(path, roots, maxBytes) {
        if (path.endsWith("render-1.png")) {
          events.push("slow-read-start");
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          const png = await readInternalPng(path, roots, maxBytes);
          events.push("slow-read-settled");
          return png;
        }
        return readInternalPng(path, roots, maxBytes);
      },
      async removePng(path, roots, options) {
        events.push(`cleanup:${path}`);
        cleanupPaths.push(path);
        await unlinkInternalPng(path, roots, options);
      },
    });

    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        views: ["iso", "top"],
        width: 256,
        height: 256,
      },
    });

    expect(rendered.isError).toBe(true);
    expect(events.indexOf("slow-read-settled")).toBeLessThan(
      events.findIndex((event) => event.startsWith("cleanup:")),
    );
    expect(cleanupPaths).toHaveLength(2);
    expect([...cleanupPaths].sort()).toEqual([...renderPaths].sort());
    await Promise.all(renderPaths.map((path) => expect(access(path)).rejects.toThrow()));
  });

  it("binds scene cleanup to the file identity read for the response", async () => {
    const cleanupIdentities: Array<{ dev: number; ino: number } | undefined> = [];
    const { client } = await startMcp({
      async removePng(_path, _roots, options) {
        cleanupIdentities.push(options?.expectedFile);
      },
    });
    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        views: ["iso"],
        width: 256,
        height: 256,
      },
    });

    expect(rendered.isError).not.toBe(true);
    expect(cleanupIdentities).toMatchObject([
      {
        dev: expect.any(Number),
        ino: expect.any(Number),
        size: expect.any(Number),
        mtimeMs: expect.any(Number),
        ctimeMs: expect.any(Number),
      },
    ]);
  });

  it("preserves an invalid render PNG without attempting unbound cleanup", async () => {
    const invalidPng = Buffer.from("not a PNG");
    const cleanupIdentities: Array<{ dev: number; ino: number } | undefined> = [];
    const { client, renderPaths } = await startMcp({
      renderPng: invalidPng,
      async removePng(_path, _roots, options) {
        cleanupIdentities.push(options?.expectedFile);
      },
    });

    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        views: ["iso"],
        width: 256,
        height: 256,
      },
    });

    expect(rendered.isError).toBe(true);
    expect(cleanupIdentities).toEqual([]);
    expect(await readFile(renderPaths[0]!)).toEqual(invalidPng);
  });

  it("preserves a replacement raced into a metadata-rejected render path", async () => {
    const replacement = Buffer.from("replacement must survive unverified cleanup");
    const cleanupIdentities: Array<{ dev: number; ino: number } | undefined> = [];
    const { client, renderPaths } = await startMcp({
      renderMetadataDimensions: { width: 255, height: 256 },
      async beforeSceneRenderResponse(paths) {
        await unlink(paths[0]!);
        await writeFile(paths[0]!, replacement);
      },
      async removePng(_path, _roots, options) {
        cleanupIdentities.push(options?.expectedFile);
      },
    });

    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        views: ["iso"],
        width: 256,
        height: 256,
      },
    });

    expect(rendered.isError).toBe(true);
    expect(cleanupIdentities).toEqual([]);
    expect(await readFile(renderPaths[0]!)).toEqual(replacement);
  });

  it("validates project state before invoking fixed desktop capture", async () => {
    const { client, calls } = await startMcp();
    const captured = await client.callTool({
      name: "desktop_capture",
      arguments: { project_id: "project-1", expected_revision: 2 },
    });
    expect(calls).toContainEqual([
      "project_get",
      { project_id: "project-1", expected_revision: 2 },
    ]);
    expect(captured.content).toContainEqual({
      type: "image",
      data: PNG.toString("base64"),
      mimeType: "image/png",
    });
  });

  it("revalidates the requested project revision after desktop capture", async () => {
    const events: string[] = [];
    let projectReads = 0;
    const { client } = await startMcp({
      bridgeCall(method) {
        if (method !== "project_get") {
          throw new Error(`Unexpected bridge call: ${method}`);
        }
        events.push("project_get");
        projectReads += 1;
        if (projectReads === 1) {
          return { project_id: "project-1", revision: 2 };
        }
        throw new BridgeError({
          code: "revision_conflict",
          message: "Expected revision 2 but active revision is 3",
          details: { expected_revision: 2, actual_revision: 3 },
        });
      },
      onDesktopCapture() {
        events.push("capture");
      },
    });

    const captured = await client.callTool({
      name: "desktop_capture",
      arguments: { project_id: "project-1", expected_revision: 2 },
    });

    expect(captured.isError).toBe(true);
    expect(captured.structuredContent).toEqual({
      ok: false,
      error: {
        code: "revision_conflict",
        message: "Expected revision 2 but active revision is 3",
        details: { expected_revision: 2, actual_revision: 3 },
      },
    });
    expect(events).toEqual(["project_get", "capture", "project_get"]);
  });

  it("rejects revision drift during desktop capture even without expected_revision", async () => {
    const events: string[] = [];
    let projectReads = 0;
    const { client } = await startMcp({
      bridgeCall(method) {
        if (method !== "project_get") {
          throw new Error(`Unexpected bridge call: ${method}`);
        }
        events.push("project_get");
        projectReads += 1;
        return {
          project_id: "project-1",
          revision: projectReads === 1 ? 2 : 3,
        };
      },
      onDesktopCapture() {
        events.push("capture");
      },
    });

    const captured = await client.callTool({
      name: "desktop_capture",
      arguments: { project_id: "project-1" },
    });

    expect(captured.isError).toBe(true);
    expect(captured.structuredContent).toEqual({
      ok: false,
      error: {
        code: "revision_conflict",
        message: "Project changed during desktop capture",
        details: {
          expected_project_id: "project-1",
          actual_project_id: "project-1",
          expected_revision: 2,
          actual_revision: 3,
        },
      },
    });
    expect(events).toEqual(["project_get", "capture", "project_get"]);
  });

  it("translates post-capture project replacement into a revision conflict", async () => {
    const events: string[] = [];
    let projectReads = 0;
    const { client } = await startMcp({
      bridgeCall(method) {
        if (method !== "project_get") {
          throw new Error(`Unexpected bridge call: ${method}`);
        }
        events.push("project_get");
        projectReads += 1;
        if (projectReads === 1) {
          return { project_id: "project-old", revision: 2 };
        }
        throw new BridgeError({
          code: "project_not_found",
          message: "Project does not exist",
          details: { active_project_id: "project-new", active_revision: 1 },
        });
      },
      onDesktopCapture() {
        events.push("capture");
      },
    });

    const captured = await client.callTool({
      name: "desktop_capture",
      arguments: { project_id: "project-old" },
    });

    expect(captured.isError).toBe(true);
    expect(captured.structuredContent).toEqual({
      ok: false,
      error: {
        code: "revision_conflict",
        message: "Project changed during desktop capture",
        details: {
          expected_project_id: "project-old",
          actual_project_id: "project-new",
          expected_revision: 2,
          actual_revision: 1,
        },
      },
    });
    expect(events).toEqual(["project_get", "capture", "project_get"]);
  });

  it("registers and validates strict job_get results", async () => {
    const { client, calls } = await startMcp();
    const job = await client.callTool({
      name: "job_get",
      arguments: { job_id: "job-1" },
    });
    expect(job.structuredContent).toMatchObject({
      job_id: "job-1",
      state: "running",
      progress: 0.5,
    });
    expect(calls).toContainEqual(["job_get", { job_id: "job-1" }]);
  });

  it("starts model import as a job", async () => {
    const { client, calls } = await startMcp();
    const started = await client.callTool({
      name: "model_import",
      arguments: {
        project_id: "project-1",
        expected_revision: 2,
        path: "/workspace/part.stl",
      },
    });
    expect(started.structuredContent).toEqual({
      job_id: "import-1",
      state: "running",
    });
    expect(calls).toContainEqual([
      "model_import",
      {
        project_id: "project-1",
        expected_revision: 2,
        path: "/workspace/part.stl",
      },
    ]);
  });

  it("starts native auto-orient for exact instances", async () => {
    const { client, calls } = await startMcp();
    const targets = [{ object_id: "object-1", instance_id: "instance-1" }];
    const started = await client.callTool({
      name: "object_auto_orient",
      arguments: {
        project_id: "project-1",
        expected_revision: 2,
        targets,
      },
    });
    expect(started.structuredContent).toEqual({
      job_id: "job-1",
      state: "running",
    });
    expect(calls).toContainEqual([
      "object_auto_orient",
      { project_id: "project-1", expected_revision: 2, targets },
    ]);
  });

  it("preserves a registered failed model-import startup job", async () => {
    const { client, calls } = await startMcp({
      bridgeCall(method) {
        if (method !== "model_import") {
          throw new Error(`Unexpected bridge call: ${method}`);
        }
        return { job_id: "import-startup-failed", state: "failed" };
      },
    });

    const started = await client.callTool({
      name: "model_import",
      arguments: {
        project_id: "project-1",
        expected_revision: 2,
        path: "/workspace/part.stl",
      },
    });

    expect(started.isError).not.toBe(true);
    expect(started.structuredContent).toEqual({
      job_id: "import-startup-failed",
      state: "failed",
    });
    expect(calls).toContainEqual([
      "model_import",
      {
        project_id: "project-1",
        expected_revision: 2,
        path: "/workspace/part.stl",
      },
    ]);
  });

  it("preserves a registered failed project-save startup job", async () => {
    const { client, calls } = await startMcp({
      bridgeCall(method) {
        if (method !== "project_save") {
          throw new Error(`Unexpected bridge call: ${method}`);
        }
        return { job_id: "save-startup-failed", state: "failed" };
      },
    });

    const started = await client.callTool({
      name: "project_save",
      arguments: {
        project_id: "project-1",
        expected_revision: 2,
        output_path: "part.3mf",
      },
    });

    expect(started.isError).not.toBe(true);
    expect(started.structuredContent).toEqual({
      job_id: "save-startup-failed",
      state: "failed",
    });
    expect(calls).toContainEqual([
      "project_save",
      {
        project_id: "project-1",
        expected_revision: 2,
        output_path: "part.3mf",
        overwrite: false,
      },
    ]);
  });

  it("forwards slice and artifact starts with schema defaults", async () => {
    const { client, calls } = await startMcp();

    expect(
      (
        await client.callTool({
          name: "slice_start",
          arguments: {
            project_id: "project-1",
            expected_revision: 4,
            plate_index: 2,
          },
        })
      ).structuredContent,
    ).toEqual({ job_id: "slice_start-1", state: "running" });
    expect(
      (
        await client.callTool({
          name: "gcode_export",
          arguments: {
            project_id: "project-1",
            expected_revision: 4,
            slice_job_id: "slice-job-1",
            output_path: "part.gcode",
          },
        })
      ).structuredContent,
    ).toEqual({ job_id: "gcode_export-1", state: "running" });
    expect(
      (
        await client.callTool({
          name: "project_save",
          arguments: {
            project_id: "project-1",
            expected_revision: 4,
            output_path: "part.3mf",
          },
        })
      ).structuredContent,
    ).toEqual({ job_id: "project_save-1", state: "running" });

    expect(calls).toContainEqual([
      "slice_start",
      { project_id: "project-1", expected_revision: 4, plate_index: 2 },
    ]);
    expect(calls).toContainEqual([
      "gcode_export",
      {
        project_id: "project-1",
        expected_revision: 4,
        slice_job_id: "slice-job-1",
        output_path: "part.gcode",
        overwrite: false,
      },
    ]);
    expect(calls).toContainEqual([
      "project_save",
      {
        project_id: "project-1",
        expected_revision: 4,
        output_path: "part.3mf",
        overwrite: false,
      },
    ]);
  });

  it("rejects unsafe artifact paths before invoking the native bridge", async () => {
    const { client, calls } = await startMcp();
    const traversal = await client.callTool({
      name: "gcode_export",
      arguments: {
        project_id: "project-1",
        expected_revision: 4,
        slice_job_id: "slice-job-1",
        output_path: "../part.gcode",
      },
    });
    const absolute = await client.callTool({
      name: "project_save",
      arguments: {
        project_id: "project-1",
        expected_revision: 4,
        output_path: "/absolute/part.3mf",
      },
    });
    const nested = await client.callTool({
      name: "gcode_export",
      arguments: {
        project_id: "project-1",
        expected_revision: 4,
        slice_job_id: "slice-job-1",
        output_path: "nested/part.gcode",
      },
    });
    const windowsNested = await client.callTool({
      name: "project_save",
      arguments: {
        project_id: "project-1",
        expected_revision: 4,
        output_path: "nested\\part.3mf",
      },
    });
    expect(traversal.isError).toBe(true);
    expect(absolute.isError).toBe(true);
    expect(nested.isError).toBe(true);
    expect(windowsNested.isError).toBe(true);
    expect(traversal.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("Invalid arguments for tool gcode_export"),
    });
    expect(absolute.content).toContainEqual({
      type: "text",
      text: expect.stringContaining("Invalid arguments for tool project_save"),
    });
    expect(calls.some(([method]) => method === "gcode_export" || method === "project_save")).toBe(
      false,
    );
  });

  it("preserves strict job metadata, warnings, failures, cancellations, and artifacts", async () => {
    const snapshot = {
      schema_version: 2,
      revision: 4,
      presets: {
        printer: "CoreXY",
        process: "0.20mm Quality",
        filaments: ["Generic PLA"],
      },
      settings: {
        layer_height: "0.2",
        first_layer_height: "0.2",
        wall_loops: "2",
      },
      overrides: [
        {
          kind: "object",
          identity: "object_10",
          settings: { wall_loops: "3" },
          effective_sha256: "c".repeat(64),
        },
        {
          kind: "volume",
          identity: "object_10/volume_12",
          settings: {},
          effective_sha256: "c".repeat(64),
        },
        {
          kind: "plate",
          identity: "plate_0",
          settings: { curr_bed_type: "1" },
          effective_sha256: "d".repeat(64),
        },
      ],
      redacted_keys: [
        "global/post_process",
        "global/printhost_password",
        "object_10/private_plugin_setting",
      ],
      sha256: "b".repeat(64),
      bytes: 4096,
    };
    const printMetrics = {
      time: { normal_seconds: 3725.5, silent_seconds: null, preparation_seconds: 18.25 },
      filament: {
        used_length_mm: 12_345.6,
        extruded_volume_mm3: 29_700.2,
        weight_g: 36.8,
        total_cost: 1.42,
        wipe_tower_used_length_mm: 320.5,
        wipe_tower_cost: 0.08,
        per_extruder: [{
          extruder_id: 0,
          model_volume_mm3: 28_000,
          support_volume_mm3: 500,
          wipe_tower_volume_mm3: 700,
          flushed_volume_mm3: 500.2,
          total_volume_mm3: 29_700.2,
        }],
        per_feature: [{ feature: "outer_wall", used_length_mm: 2345.6, weight_g: 7.1 }],
      },
      changes: { tool_changes: 2, filament_changes: 3, extruder_changes: 2 },
      travel: { distance_mm: 40_000, move_count: 900 },
      initial_tool: 0,
    };
    const jobs: Record<string, Record<string, unknown>> = {
      "import-success": {
        job_id: "import-success",
        type: "model_import",
        state: "succeeded",
        progress: 1,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: {},
        result: {
          project_id: "project-1",
          revision: 5,
          object_ids: ["object-1"],
        },
        error: null,
        revision: 5,
      },
      "arrange-success": {
        job_id: "arrange-success",
        type: "arrange",
        state: "succeeded",
        progress: 1,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: { config_snapshot: snapshot },
        result: { arranged: true },
        error: null,
        revision: 5,
      },
      "auto-orient-success": {
        job_id: "auto-orient-success",
        type: "auto_orient",
        state: "succeeded",
        progress: 1,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: { config_snapshot: snapshot },
        result: { oriented: true },
        error: null,
        revision: 5,
      },
      "slice-success": {
        job_id: "slice-success",
        type: "slice",
        state: "succeeded",
        progress: 1,
        project_id: "project-1",
        source_revision: 4,
        warnings: [
          { code: "thin_wall", message: "Thin wall detected", details: { object_id: "object-1" } },
        ],
        metadata: { plate_index: 2, config_snapshot: snapshot },
        result: { plate_index: 2, sliced: true, print_metrics: printMetrics },
        error: null,
        revision: 4,
      },
      "slice-failed": {
        job_id: "slice-failed",
        type: "slice",
        state: "failed",
        progress: 0.4,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: { plate_index: 2, config_snapshot: snapshot },
        result: null,
        error: {
          code: "slice_failed",
          message: "Native slicer failed",
          details: { plate_index: 2 },
        },
        revision: 4,
      },
      "export-success": {
        job_id: "export-success",
        type: "gcode_export",
        state: "succeeded",
        progress: 1,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: {
          slice_job_id: "slice-success",
          output_path: "part.gcode",
          config_snapshot: snapshot,
        },
        result: {
          path: "/outputs/part.gcode",
          bytes: 2048,
          slice_job_id: "slice-success",
        },
        error: null,
        revision: 4,
      },
      "save-cancelled": {
        job_id: "save-cancelled",
        type: "project_save",
        state: "cancelled",
        progress: 0.25,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: {
          output_path: "part.3mf",
          config_snapshot: snapshot,
        },
        result: null,
        error: {
          code: "cancelled",
          message: "Save cancelled",
          details: null,
        },
        revision: 4,
      },
      "save-running": {
        job_id: "save-running",
        type: "project_save",
        state: "running",
        progress: 0,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: {
          output_path: "part.3mf",
          config_snapshot: snapshot,
        },
        result: null,
        error: null,
        revision: 4,
      },
      "save-failed-before-prep": {
        job_id: "save-failed-before-prep",
        type: "project_save",
        state: "failed",
        progress: 0,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: { output_path: "part.3mf" },
        result: null,
        error: {
          code: "invalid_request",
          message: "Configuration snapshot exceeds the response size limit",
          details: null,
        },
        revision: 4,
      },
      "save-success": {
        job_id: "save-success",
        type: "project_save",
        state: "succeeded",
        progress: 1,
        project_id: "project-1",
        source_revision: 4,
        warnings: [],
        metadata: {
          output_path: "part.3mf",
          config_snapshot: snapshot,
        },
        result: {
          path: "/outputs/part.3mf",
          bytes: 4096,
        },
        error: null,
        revision: 4,
      },
    };
    const { client } = await startMcp({
      bridgeCall(method, params) {
        expect(method).toBe("job_get");
        return jobs[String(params.job_id)];
      },
    });

    for (const job of Object.values(jobs)) {
      const result = await client.callTool({
        name: "job_get",
        arguments: { job_id: job.job_id },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(job);
    }
    expect(JSON.stringify(jobs)).not.toContain("must-not-leak");
  });

  it("rejects malformed native job metadata instead of widening the MCP contract", async () => {
    const { client } = await startMcp({
      bridgeCall(method, params) {
        expect(method).toBe("job_get");
        if (params.job_id === "arrange-1") {
          return {
            job_id: "arrange-1",
            type: "arrange",
            state: "succeeded",
            progress: 1,
            project_id: "project-1",
            source_revision: 4,
            warnings: [],
            metadata: null,
            result: { arranged: true },
            error: null,
            revision: 5,
          };
        }
        if (params.job_id === "invalid-settings") {
          return {
            job_id: "invalid-settings",
            type: "slice",
            state: "running",
            progress: 0.5,
            project_id: "project-1",
            source_revision: 4,
            warnings: [],
            metadata: {
              plate_index: 0,
              config_snapshot: {
                schema_version: 2,
                revision: 4,
                presets: {
                  printer: "CoreXY",
                  process: "0.20mm Quality",
                  filaments: ["Generic PLA"],
                },
                settings: {
                  layer_height: 0.2,
                  wall_loops: "2",
                },
                overrides: [],
                redacted_keys: ["global/post_process", "global/printhost_password"],
                sha256: "c".repeat(64),
                bytes: 4096,
              },
            },
            result: null,
            error: null,
            revision: 4,
          };
        }
        if (params.job_id === "invalid-snapshot-security") {
          return {
            job_id: "invalid-snapshot-security",
            type: "slice",
            state: "running",
            progress: 0.5,
            project_id: "project-1",
            source_revision: 4,
            warnings: [],
            metadata: {
              plate_index: 0,
              config_snapshot: {
                schema_version: 2,
                revision: 4,
                presets: {
                  printer: "CoreXY",
                  process: "0.20mm Quality",
                  filaments: ["Generic PLA"],
                },
                settings: {
                  layer_height: "0.2",
                  printhost_password: "must-not-leak",
                  wall_loops: "2",
                },
                overrides: [],
                redacted_keys: ["global/printhost_password", "global/post_process"],
                sha256: "NOT-A-CANONICAL-HASH",
                bytes: 524_289,
              },
            },
            result: null,
            error: null,
            revision: 4,
          };
        }
        if (params.job_id === "unsafe-override") {
          return {
            job_id: "unsafe-override",
            type: "slice",
            state: "running",
            progress: 0.5,
            project_id: "project-1",
            source_revision: 4,
            warnings: [],
            metadata: {
              plate_index: 0,
              config_snapshot: {
                schema_version: 2,
                revision: 4,
                presets: {
                  printer: "CoreXY",
                  process: "0.20mm Quality",
                  filaments: ["Generic PLA"],
                },
                settings: { layer_height: "0.2" },
                overrides: [{
                  kind: "object",
                  identity: "object_10",
                  settings: {
                    wall_loops: "3",
                    printhost_password: "must-not-leak",
                  },
                  effective_sha256: "e".repeat(64),
                  path: "/tmp/must-not-leak",
                }],
                redacted_keys: ["object_10/printhost_password"],
                sha256: "f".repeat(64),
                bytes: 4096,
              },
            },
            result: null,
            error: null,
            revision: 4,
          };
        }
        if (params.job_id === "successful-save-without-snapshot") {
          return {
            job_id: "successful-save-without-snapshot",
            type: "project_save",
            state: "succeeded",
            progress: 1,
            project_id: "project-1",
            source_revision: 4,
            warnings: [],
            metadata: { output_path: "part.3mf" },
            result: { path: "/outputs/part.3mf", bytes: 1024 },
            error: null,
            revision: 4,
          };
        }
        return {
          job_id: "slice-1",
          type: "slice",
          state: "running",
          progress: 0.5,
          project_id: "project-1",
          source_revision: 4,
          warnings: [],
          metadata: {
            plate_index: 0,
            config_snapshot: {
              schema_version: 2,
              revision: 4,
              presets: {
                printer: "CoreXY",
                process: "0.20mm Quality",
                filaments: ["Generic PLA"],
              },
              settings: {
                layer_height: "0.2",
                wall_loops: "2",
              },
              overrides: [],
              redacted_keys: ["global/post_process", "global/printhost_password"],
              sha256: "d".repeat(64),
              bytes: 4096,
            },
            unexpected: true,
          },
          result: null,
          error: null,
          revision: 4,
        };
      },
    });
    const result = await client.callTool({
      name: "job_get",
      arguments: { job_id: "slice-1" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "mcp_adapter_error" },
    });
    const arrangeResult = await client.callTool({
      name: "job_get",
      arguments: { job_id: "arrange-1" },
    });
    expect(arrangeResult.isError).toBe(true);
    expect(arrangeResult.structuredContent).toMatchObject({
      ok: false,
      error: { code: "mcp_adapter_error" },
    });
    const invalidSettingsResult = await client.callTool({
      name: "job_get",
      arguments: { job_id: "invalid-settings" },
    });
    expect(invalidSettingsResult.isError).toBe(true);
    expect(invalidSettingsResult.structuredContent).toMatchObject({
      ok: false,
      error: { code: "mcp_adapter_error" },
    });
    const invalidSecurityResult = await client.callTool({
      name: "job_get",
      arguments: { job_id: "invalid-snapshot-security" },
    });
    expect(invalidSecurityResult.isError).toBe(true);
    expect(JSON.stringify(invalidSecurityResult.structuredContent)).not.toContain(
      "must-not-leak",
    );
    const unsafeOverride = await client.callTool({
      name: "job_get",
      arguments: { job_id: "unsafe-override" },
    });
    expect(unsafeOverride.isError).toBe(true);
    expect(JSON.stringify(unsafeOverride.structuredContent)).not.toContain("must-not-leak");
    const successfulSaveWithoutSnapshot = await client.callTool({
      name: "job_get",
      arguments: { job_id: "successful-save-without-snapshot" },
    });
    expect(successfulSaveWithoutSnapshot.isError).toBe(true);
  });

  it("lists and atomically selects exact compatible presets", async () => {
    const { client, calls } = await startMcp();
    const listed = await client.callTool({
      name: "presets_list",
      arguments: {
        project_id: "project-1",
        expected_revision: 2,
        scopes: ["printer", "process", "filament"],
        compatible_only: true,
      },
    });
    expect(listed.structuredContent).toMatchObject({
      project_id: "project-1",
      revision: 2,
      selected: { printer: "CoreXY", filaments: ["Generic PLA"] },
    });
    expect(
      (listed.structuredContent as { presets: unknown[] }).presets,
    ).toContainEqual({
      scope: "printer",
      name: "CoreXY",
      selected: true,
      compatible: true,
    });
    expect(calls).toContainEqual([
      "presets_list",
      {
        project_id: "project-1",
        expected_revision: 2,
        scopes: ["printer", "process", "filament"],
        compatible_only: true,
      },
    ]);

    const selected = await client.callTool({
      name: "presets_select",
      arguments: {
        project_id: "project-1",
        expected_revision: 2,
        selection: {
          process: "0.16mm Quality",
          filaments: ["Generic PLA"],
        },
      },
    });
    expect(selected.structuredContent).toMatchObject({
      revision: 3,
      selected: { process: "0.16mm Quality" },
    });
    expect(calls).toContainEqual([
      "presets_select",
      {
        project_id: "project-1",
        expected_revision: 2,
        selection: {
          process: "0.16mm Quality",
          filaments: ["Generic PLA"],
        },
        discard_dirty: false,
      },
    ]);
  });

  it("discovers paginated settings with filters and reads effective typed values", async () => {
    const { client, calls } = await startMcp();
    const described = await client.callTool({
      name: "settings_describe",
      arguments: {
        project_id: "project-1",
        expected_revision: 3,
        query: "layer",
        scopes: ["process"],
        cursor: "page-1",
        limit: 1,
      },
    });
    expect(described.structuredContent).toEqual({
      project_id: "project-1",
      revision: 3,
      items: [
        {
          key: "layer_height",
          scope: "process",
          label: "Layer height",
          description: "Height of each printed layer.",
          type: "float",
          nullable: false,
          read_only: false,
          unit: "mm",
          min: 0.01,
          max: 2,
          max_literal: null,
          enum_values: null,
        },
      ],
      next_cursor: "page-2",
    });
    expect(calls).toContainEqual([
      "settings_describe",
      {
        project_id: "project-1",
        expected_revision: 3,
        query: "layer",
        scopes: ["process"],
        cursor: "page-1",
        limit: 1,
      },
    ]);

    const values = await client.callTool({
      name: "settings_get",
      arguments: {
        project_id: "project-1",
        expected_revision: 3,
        settings: [{ key: "layer_height", scope: "process" }],
      },
    });
    expect(values.structuredContent).toEqual({
      project_id: "project-1",
      revision: 3,
      values: [
        { key: "layer_height", scope: "process", value: 0.2, unit: "mm" },
      ],
    });
  });

  it("does not describe, read, or apply unsafe settings", async () => {
    const { client, calls } = await startMcp({
      bridgeCall(method) {
        expect(method).toBe("settings_describe");
        return {
          project_id: "project-1",
          revision: 3,
          items: [
            {
              key: "printhost_password",
              scope: "printer",
              label: "Password",
              description: "Must never cross the agent boundary.",
              type: "string",
              nullable: false,
              read_only: false,
              unit: null,
              min: null,
              max: null,
              max_literal: null,
              enum_values: null,
            },
          ],
          next_cursor: null,
        };
      },
    });

    const described = await client.callTool({
      name: "settings_describe",
      arguments: {
        project_id: "project-1",
        expected_revision: 3,
        scopes: ["printer"],
      },
    });
    expect(described.isError).toBe(true);
    expect(JSON.stringify(described.structuredContent)).not.toContain("printhost_password");

    for (const key of [
      "bed_custom_model",
      "print_host",
      "printhost_apikey",
      "post_process",
      "slicing_pipeline_plugin",
      "host_authorization",
      "custom_executable_path",
    ]) {
      const read = await client.callTool({
        name: "settings_get",
        arguments: {
          project_id: "project-1",
          expected_revision: 3,
          settings: [{ key, scope: "printer" }],
        },
      });
      expect(read.isError, key).toBe(true);

      const applied = await client.callTool({
        name: "settings_apply",
        arguments: {
          project_id: "project-1",
          expected_revision: 3,
          changes: [{ key, scope: "printer", value: "unsafe" }],
          dry_run: true,
        },
      });
      expect(applied.isError, key).toBe(true);
    }
    expect(calls.map(([method]) => method)).toEqual(["settings_describe"]);
  });

  it("supports settings dry runs and forwards typed values unchanged on apply", async () => {
    const { client, calls } = await startMcp();
    const changes = [
      { key: "layer_height", scope: "process", value: 0.16 },
      { key: "compatible_printers", scope: "process", value: ["CoreXY"] },
    ];
    const dryRun = await client.callTool({
      name: "settings_apply",
      arguments: {
        project_id: "project-1",
        expected_revision: 3,
        changes,
        dry_run: true,
      },
    });
    expect(dryRun.structuredContent).toEqual({
      project_id: "project-1",
      revision: 3,
      dry_run: true,
      applied: changes,
    });

    const applied = await client.callTool({
      name: "settings_apply",
      arguments: {
        project_id: "project-1",
        expected_revision: 3,
        changes,
        dry_run: false,
      },
    });
    expect(applied.structuredContent).toEqual({
      project_id: "project-1",
      revision: 4,
      dry_run: false,
      applied: changes,
    });
    expect(calls).toContainEqual([
      "settings_apply",
      {
        project_id: "project-1",
        expected_revision: 3,
        changes,
        dry_run: true,
      },
    ]);
  });

  it("preserves per-filament indices and nested typed values", async () => {
    const { client, calls } = await startMcp({
      bridgeCall(method, params) {
        if (method === "settings_get") {
          return {
            project_id: "project-1",
            revision: 3,
            values: [
              {
                key: "line_width",
                scope: "filament",
                filament_index: 1,
                value: { value: 105, percent: true },
                unit: "mm or %",
              },
            ],
          };
        }
        if (method === "settings_apply") {
          return {
            project_id: "project-1",
            revision: 3,
            dry_run: true,
            applied: params.changes,
          };
        }
        return { project_id: "project-1", revision: 3 };
      },
    });

    const value = await client.callTool({
      name: "settings_get",
      arguments: {
        project_id: "project-1",
        expected_revision: 3,
        settings: [{ key: "line_width", scope: "filament", filament_index: 1 }],
      },
    });
    expect(value.structuredContent).toMatchObject({
      values: [
        {
          key: "line_width",
          scope: "filament",
          filament_index: 1,
          value: { value: 105, percent: true },
        },
      ],
    });

    const changes = [
      {
        key: "line_width",
        scope: "filament",
        filament_index: 1,
        value: { value: 0.44, percent: false },
      },
      {
        key: "extruder_printable_area",
        scope: "printer",
        value: [[[0, 0], [100, 0], [100, 100]]],
      },
    ];
    const applied = await client.callTool({
      name: "settings_apply",
      arguments: {
        project_id: "project-1",
        expected_revision: 3,
        changes,
        dry_run: true,
      },
    });
    expect(applied.structuredContent).toMatchObject({ dry_run: true, applied: changes });
    expect(calls).toContainEqual([
      "settings_apply",
      {
        project_id: "project-1",
        expected_revision: 3,
        changes,
        dry_run: true,
      },
    ]);
  });

  it("rejects malformed native settings results", async () => {
    const { client } = await startMcp({
      bridgeCall(method) {
        expect(method).toBe("settings_get");
        return {
          project_id: "project-1",
          revision: 3,
          values: [
            {
              key: "layer_height",
              scope: "process",
              value: { guessed_unit: "mm", value: 0.2 },
              unit: "mm",
            },
          ],
        };
      },
    });
    const result = await client.callTool({
      name: "settings_get",
      arguments: {
        project_id: "project-1",
        settings: [{ key: "layer_height", scope: "process" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: "mcp_adapter_error" },
    });
  });

  it("preserves stale revision and atomic native validation error shapes", async () => {
    let callCount = 0;
    const { client } = await startMcp({
      bridgeCall(method) {
        expect(method).toBe("settings_apply");
        callCount += 1;
        if (callCount === 1) {
          throw new BridgeError({
            code: "revision_conflict",
            message: "Expected revision 2 but active revision is 3",
            details: { expected_revision: 2, actual_revision: 3 },
          });
        }
        throw new BridgeError({
          code: "invalid_request",
          message: "Settings batch rejected",
          details: {
            atomic: true,
            errors: [
              {
                key: "layer_height",
                scope: "process",
                code: "out_of_range",
                message: "Value exceeds maximum 2 mm",
              },
            ],
          },
        });
      },
    });
    const arguments_ = {
      project_id: "project-1",
      expected_revision: 2,
      changes: [{ key: "layer_height", scope: "process", value: 3 }],
      dry_run: false,
    };
    const stale = await client.callTool({ name: "settings_apply", arguments: arguments_ });
    expect(stale.isError).toBe(true);
    expect(stale.structuredContent).toEqual({
      ok: false,
      error: {
        code: "revision_conflict",
        message: "Expected revision 2 but active revision is 3",
        details: { expected_revision: 2, actual_revision: 3 },
      },
    });

    const invalid = await client.callTool({ name: "settings_apply", arguments: arguments_ });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toEqual({
      ok: false,
      error: {
        code: "invalid_request",
        message: "Settings batch rejected",
        details: {
          atomic: true,
          errors: [
            {
              key: "layer_height",
              scope: "process",
              code: "out_of_range",
              message: "Value exceeds maximum 2 mm",
            },
          ],
        },
      },
    });
  });

  it("rejects mismatched PNG dimensions and still removes the render artifact", async () => {
    const { client, renderPaths } = await startMcp({ renderPng: pngFixture(1, 1) });
    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        views: ["iso"],
        width: 256,
        height: 256,
      },
    });
    expect(rendered.isError).toBe(true);
    expect(rendered.structuredContent).toMatchObject({
      error: { code: "mcp_adapter_error" },
    });
    await expect(access(renderPaths[0]!)).rejects.toThrow();
  });

  it.each([
    ["missing", ["iso"]],
    ["duplicate", ["iso", "iso"]],
    ["out of order", ["top", "iso"]],
  ])("rejects %s native render results without deleting unverified artifacts", async (
    _name,
    renderViews,
  ) => {
    const { client, renderPaths } = await startMcp({ renderViews });
    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        views: ["iso", "top"],
        width: 256,
        height: 256,
      },
    });
    expect(rendered.isError).toBe(true);
    expect(rendered.structuredContent).toMatchObject({
      error: { code: "mcp_adapter_error" },
    });
    await Promise.all(
      renderPaths.map((path) => expect(readFile(path)).resolves.toEqual(PNG)),
    );
  });

  it("reports scene cleanup failures without affecting streamed desktop capture", async () => {
    const removePng: NonNullable<ToolDependencies["removePng"]> = async () => {
      throw new Error("simulated unlink failure");
    };
    const { client } = await startMcp({ removePng });
    const rendered = await client.callTool({
      name: "scene_render",
      arguments: {
        project_id: "project-1",
        views: ["iso"],
        width: 256,
        height: 256,
      },
    });
    expect(rendered.isError).toBe(true);
    expect(rendered.structuredContent).toMatchObject({
      error: { message: "simulated unlink failure" },
    });

    const captured = await client.callTool({
      name: "desktop_capture",
      arguments: { project_id: "project-1" },
    });
    expect(captured.isError).not.toBe(true);
    expect(captured.structuredContent).toMatchObject({
      image: { mime_type: "image/png", diagnostic: true },
    });
  });

  it("enforces bearer authentication and Host/Origin allowlists", async () => {
    const { endpoint } = await startMcp({ bearerToken: "deployment-secret" });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const request = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const outgoing = httpRequest(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "content-length": Buffer.byteLength(body),
            ...headers,
          },
        }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 0));
        });
        outgoing.once("error", reject);
        outgoing.end(body);
      });

    expect(await request({})).toBe(401);
    expect(
      await request({
        authorization: "Bearer wrong-secret",
      }),
    ).toBe(401);
    expect(
      await request({
        host: "attacker.example",
        authorization: "Bearer deployment-secret",
      }),
    ).toBe(403);
    expect(
      await request({
        origin: "https://attacker.example",
        authorization: "Bearer deployment-secret",
      }),
    ).toBe(403);
    expect(
      await request({
        origin: "http://127.0.0.1",
        authorization: "Bearer deployment-secret",
      }),
    ).not.toBe(401);
  });
});
