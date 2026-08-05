#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { basename, resolve } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = new URL(
  process.env.AGENT_SLICER_MCP_URL ?? "http://127.0.0.1:8765/mcp",
);
const token = process.env.AGENT_SLICER_TOKEN;
if (!token) {
  throw new Error("AGENT_SLICER_TOKEN is required");
}

const repoRoot = resolve(new URL("../../..", import.meta.url).pathname);
const artifactsDir = resolve(
  process.env.AGENT_SLICER_E2E_ARTIFACTS ?? `${repoRoot}/runtime/e2e-artifacts`,
);
const outputsDir = resolve(
  process.env.AGENT_SLICER_E2E_OUTPUTS ?? `${repoRoot}/runtime/outputs`,
);
const workspaceDir = resolve(
  process.env.AGENT_SLICER_E2E_WORKSPACE ?? `${repoRoot}/runtime/workspace`,
);
const fixtureSourcePath = resolve(
  process.env.AGENT_SLICER_E2E_FIXTURE_SOURCE ?? `${repoRoot}/tests/data/20mm_cube.obj`,
);
const importLimitBytes = Number(
  process.env.AGENT_SLICER_MAX_IMPORT_BYTES ?? 512 * 1024 * 1024,
);
if (!Number.isSafeInteger(importLimitBytes) || importLimitBytes <= 0) {
  throw new Error("AGENT_SLICER_MAX_IMPORT_BYTES must be a positive safe integer");
}
await mkdir(artifactsDir, { recursive: true });

const state = {
  endpoint: endpoint.href,
  started_at: new Date().toISOString(),
  steps: [],
};

function record(name, details = {}) {
  state.steps.push({ name, at: new Date().toISOString(), ...details });
  process.stdout.write(`[e2e] ${name}\n`);
}

async function bundledBambuPresetNames() {
  const profilesRoot = resolve(repoRoot, "resources/profiles");
  const manifest = JSON.parse(await readFile(resolve(profilesRoot, "BBL.json"), "utf8"));
  const printers = [];
  for (const entry of manifest.machine_model_list) {
    const model = JSON.parse(
      await readFile(resolve(profilesRoot, "BBL", entry.sub_path), "utf8"),
    );
    for (const nozzle of model.nozzle_diameter.split(";")) {
      printers.push(`${model.name} ${nozzle} nozzle`);
    }
  }

  const genericFilaments = [];
  for (const entry of manifest.filament_list) {
    if (!entry.name.startsWith("Generic ")) {
      continue;
    }
    const filament = JSON.parse(
      await readFile(resolve(profilesRoot, "BBL", entry.sub_path), "utf8"),
    );
    if (filament.instantiation === "true") {
      genericFilaments.push(filament.name);
    }
  }
  return { printers, genericFilaments };
}

function structured(result) {
  if (result.isError) {
    throw new Error(`Tool returned an error: ${JSON.stringify(result.structuredContent)}`);
  }
  if (!result.structuredContent || typeof result.structuredContent !== "object") {
    throw new Error(`Tool omitted structured content: ${JSON.stringify(result)}`);
  }
  return result.structuredContent;
}

function requireErrorCode(result, expectedCode, label) {
  const actualCode = result.structuredContent?.error?.code;
  if (result.isError !== true || actualCode !== expectedCode) {
    throw new Error(
      `${label}: expected ${expectedCode}, received ${JSON.stringify(result.structuredContent)}`,
    );
  }
}

async function expectToolFailure(client, name, args, expectedCode, label) {
  const result = await client.callTool({ name, arguments: args });
  requireErrorCode(result, expectedCode, label);
  record(label, { error: result.structuredContent });
}

async function expectValidationFailure(client, name, args, label) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n") ?? "";
  if (result.isError !== true || !text.includes(`Invalid arguments for tool ${name}`)) {
    throw new Error(`${label}: expected tool input validation failure, received ${text}`);
  }
  record(label, { error: text });
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { result, value: structured(result) };
}

async function waitForJob(client, jobId, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastProgress = -1;
  while (Date.now() < deadline) {
    const { value } = await call(client, "job_get", { job_id: jobId });
    if (value.progress !== lastProgress) {
      lastProgress = value.progress;
      process.stdout.write(
        `[e2e] job ${jobId}: ${value.state} ${Math.round(Number(value.progress) * 100)}%\n`,
      );
    }
    if (value.state === "succeeded") {
      return value;
    }
    if (value.state === "failed" || value.state === "cancelled") {
      throw new Error(`Job ${jobId} ${value.state}: ${JSON.stringify(value.error)}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

function assertSucceededJob(job, type, project, selectedPresets) {
  if (
    job.type !== type ||
    job.state !== "succeeded" ||
    job.progress !== 1 ||
    job.project_id !== project.project_id ||
    job.source_revision !== project.revision ||
    !Array.isArray(job.warnings) ||
    job.error !== null ||
    !validConfigSnapshot(
      job.metadata?.config_snapshot,
      project.revision,
      selectedPresets,
    )
  ) {
    throw new Error(`Invalid completed ${type} job contract: ${JSON.stringify(job)}`);
  }
}

async function expectRejectedJob(client, name, args, expectedCode, label) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    requireErrorCode(result, expectedCode, label);
    record(label, { error: result.structuredContent });
    return;
  }
  const value = structured(result);
  if (typeof value.job_id !== "string") {
    throw new Error(`${label}: operation returned neither an error nor a job`);
  }
  const deadline = Date.now() + 2 * 60_000;
  while (Date.now() < deadline) {
    const job = (await call(client, "job_get", { job_id: value.job_id })).value;
    if (job.state === "failed") {
      if (job.error?.code !== expectedCode) {
        throw new Error(
          `${label}: expected failed job code ${expectedCode}, received ${JSON.stringify(job.error)}`,
        );
      }
      record(label, { error: job.error, job_id: value.job_id });
      return;
    }
    if (job.state === "succeeded" || job.state === "cancelled") {
      throw new Error(`${label}: job unexpectedly ended as ${job.state}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }
  throw new Error(`${label}: timed out waiting for the expected job failure`);
}

async function savePngs(result, prefix) {
  const images = result.content.filter((item) => item.type === "image");
  if (images.length === 0) {
    throw new Error(`${prefix}: no PNG image content returned`);
  }
  const hashes = [];
  for (const [index, image] of images.entries()) {
    if (image.mimeType !== "image/png") {
      throw new Error(`${prefix}: unexpected image type ${image.mimeType}`);
    }
    const png = Buffer.from(image.data, "base64");
    if (png.length < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new Error(`${prefix}: invalid PNG payload`);
    }
    await writeFile(resolve(artifactsDir, `${prefix}-${index + 1}.png`), png);
    hashes.push(createHash("sha256").update(png).digest("hex"));
  }
  return hashes;
}

function closeTo(actual, expected, tolerance = 0.05) {
  return Math.abs(Number(actual) - Number(expected)) <= tolerance;
}

function angleDelta(actual, expected) {
  return Math.abs((((Number(actual) - Number(expected)) % 360) + 540) % 360 - 180);
}

function equalJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const unsafeSnapshotSettingNames = new Set([
  "bed_custom_model",
  "bed_custom_texture",
  "bbl_use_printhost",
  "datadir",
  "filename_format",
  "input_filename_base",
  "logfile",
  "outputdir",
  "print_host",
  "print_host_webui",
  "printer_agent",
  "printhost_cafile",
  "post_process",
  "slicing_pipeline_plugin",
  "plugins",
]);

function safeSnapshotSettingName(key) {
  const normalized = key.toLowerCase();
  return !unsafeSnapshotSettingNames.has(normalized) &&
    !normalized.startsWith("printhost_") &&
    !normalized.startsWith("host_") &&
    !normalized.includes("password") &&
    !normalized.includes("credential") &&
    !normalized.includes("token") &&
    !normalized.includes("secret") &&
    !normalized.includes("apikey") &&
    !normalized.includes("api_key") &&
    !normalized.includes("plugin") &&
    !normalized.includes("script") &&
    !normalized.includes("executable") &&
    !normalized.includes("authorization") &&
    !["_path", "_file", "_directory", "_url", "_command", "_gcode"].some(
      (suffix) => normalized.endsWith(suffix),
    );
}

function validSnapshotSettings(settings) {
  return settings &&
    !Array.isArray(settings) &&
    Object.keys(settings).length <= 4096 &&
    Object.entries(settings).every(([key, value]) =>
      key.length > 0 &&
      key.length <= 256 &&
      safeSnapshotSettingName(key) &&
      typeof value === "string" &&
      value.length <= 65_536
    );
}

function validSnapshotOverride(override) {
  if (
    !override ||
    !equalJson(
      Object.keys(override).sort(),
      ["effective_sha256", "identity", "kind", "settings"],
    ) ||
    !validSnapshotSettings(override.settings) ||
    !/^[0-9a-f]{64}$/.test(override.effective_sha256)
  ) {
    return false;
  }
  if (override.kind === "object") {
    return /^object_\d+$/.test(override.identity);
  }
  if (override.kind === "volume") {
    return /^object_\d+\/volume_\d+$/.test(override.identity);
  }
  return override.kind === "plate" && /^plate_\d+$/.test(override.identity);
}

function stableSnapshotOverrideOrder(overrides) {
  let objectId = -1;
  let volumeId = -1;
  let plateId = -1;
  let sawPlate = false;
  for (const override of overrides) {
    if (override.kind === "object") {
      const nextObjectId = Number(override.identity.slice("object_".length));
      if (sawPlate || nextObjectId <= objectId) {
        return false;
      }
      objectId = nextObjectId;
      volumeId = -1;
    } else if (override.kind === "volume") {
      const match = /^object_(\d+)\/volume_(\d+)$/.exec(override.identity);
      if (sawPlate || match === null ||
          Number(match[1]) !== objectId || Number(match[2]) <= volumeId) {
        return false;
      }
      volumeId = Number(match[2]);
    } else {
      const nextPlateId = Number(override.identity.slice("plate_".length));
      if (nextPlateId <= plateId) {
        return false;
      }
      sawPlate = true;
      plateId = nextPlateId;
    }
  }
  return true;
}

function validRedactedSettingPath(path) {
  const match = /^(global|object_\d+|object_\d+\/volume_\d+|plate_\d+)\/([^/]+)$/.exec(path);
  return match !== null &&
    match[2].length <= 256 &&
    !safeSnapshotSettingName(match[2]);
}

function validConfigSnapshot(snapshot, revision, selectedPresets) {
  const settings = snapshot?.settings;
  const overrides = snapshot?.overrides;
  const redactedKeys = snapshot?.redacted_keys;
  const overrideKinds = new Set(
    Array.isArray(overrides) ? overrides.map((override) => override.kind) : [],
  );
  return snapshot?.schema_version === 2 &&
    snapshot?.revision === revision &&
    equalJson(snapshot?.presets, selectedPresets) &&
    validSnapshotSettings(settings) &&
    Object.keys(settings).length > 0 &&
    typeof settings.layer_height === "string" &&
    settings.layer_height.length > 0 &&
    typeof settings.wall_loops === "string" &&
    settings.wall_loops.length > 0 &&
    Array.isArray(overrides) &&
    overrides.length > 0 &&
    overrides.length <= 4096 &&
    overrides.every(validSnapshotOverride) &&
    new Set(overrides.map((override) => override.identity)).size === overrides.length &&
    stableSnapshotOverrideOrder(overrides) &&
    ["object", "volume", "plate"].every((kind) => overrideKinds.has(kind)) &&
    Array.isArray(redactedKeys) &&
    redactedKeys.length > 0 &&
    redactedKeys.includes("global/post_process") &&
    redactedKeys.every(validRedactedSettingPath) &&
    equalJson(redactedKeys, [...new Set(redactedKeys)].sort()) &&
    /^[0-9a-f]{64}$/.test(snapshot?.sha256) &&
    Number.isSafeInteger(snapshot?.bytes) &&
    snapshot.bytes > 0 &&
    snapshot.bytes <= 524_288;
}

function changedScalar(descriptor, current) {
  if (Array.isArray(descriptor.enum_values)) {
    const alternate = descriptor.enum_values.find((value) => !equalJson(value, current));
    if (alternate !== undefined) {
      return alternate;
    }
  }
  if (typeof current === "boolean") {
    return !current;
  }
  if (typeof current === "number") {
    const minimum = descriptor.min ?? -Number.MAX_SAFE_INTEGER;
    const maximum = descriptor.max ?? Number.MAX_SAFE_INTEGER;
    const step = descriptor.type.includes("int") ? 1 : Math.max(0.01, Math.abs(current) * 0.05);
    if (current + step <= maximum) {
      return current + step;
    }
    if (current - step >= minimum) {
      return current - step;
    }
  }
  if (
    current &&
    typeof current === "object" &&
    !Array.isArray(current) &&
    typeof current.value === "number" &&
    typeof current.percent === "boolean"
  ) {
    const minimum = descriptor.min ?? -Number.MAX_SAFE_INTEGER;
    const maximum = descriptor.max ?? Number.MAX_SAFE_INTEGER;
    const step = Math.max(0.01, Math.abs(current.value) * 0.05);
    if (current.value + step <= maximum) {
      return { ...current, value: current.value + step };
    }
    if (current.value - step >= minimum) {
      return { ...current, value: current.value - step };
    }
  }
  return undefined;
}

async function fetchStatus(url, authorization) {
  const response = await fetch(url, {
    headers: authorization ? { authorization } : {},
  });
  return response.status;
}

async function fetchRejectedMcpStatus(headers) {
  const body = "{}";
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        ...headers,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolvePromise(response.statusCode ?? 0));
      response.once("error", rejectPromise);
    });
    request.once("error", rejectPromise);
    request.end(body);
  });
}

const baseUrl = new URL("/", endpoint);
const missingStatus = await fetchStatus(endpoint);
if (missingStatus !== 401) {
  throw new Error(`Missing-token request returned ${missingStatus}, expected 401`);
}
const wrongStatus = await fetchStatus(endpoint, "Bearer definitely-wrong");
if (wrongStatus !== 401) {
  throw new Error(`Wrong-token request returned ${wrongStatus}, expected 401`);
}
const missingOutputStatus = await fetchStatus(new URL("outputs/", baseUrl));
if (missingOutputStatus !== 401) {
  throw new Error(`Missing-token output request returned ${missingOutputStatus}, expected 401`);
}
record("authentication rejects missing and wrong bearer tokens");

const rejectedHostStatus = await fetchRejectedMcpStatus({ host: "attacker.example" });
if (rejectedHostStatus !== 403) {
  throw new Error(`Disallowed Host returned ${rejectedHostStatus}, expected 403`);
}
const rejectedOriginStatus = await fetchRejectedMcpStatus({
  origin: "https://attacker.example",
});
if (rejectedOriginStatus !== 403) {
  throw new Error(`Disallowed Origin returned ${rejectedOriginStatus}, expected 403`);
}
record("Host and Origin allowlists reject untrusted HTTP requests");

for (const healthPath of ["livez", "readyz", "healthz"]) {
  const response = await fetch(new URL(healthPath, baseUrl));
  if (!response.ok) {
    throw new Error(`${healthPath} returned ${response.status}: ${await response.text()}`);
  }
}
record("health endpoints are ready");

await mkdir(workspaceDir, { recursive: true });
const importSymlinkName = "e2e-import-symlink.obj";
const importSymlinkPath = resolve(workspaceDir, importSymlinkName);
const oversizedImportName = "e2e-oversized-import.obj";
const oversizedImportPath = resolve(workspaceDir, oversizedImportName);
await rm(importSymlinkPath, { force: true });
await rm(oversizedImportPath, { force: true });
await symlink("/etc/passwd", importSymlinkPath);
await writeFile(oversizedImportPath, "");
await truncate(oversizedImportPath, importLimitBytes + 1);

const client = new Client(
  { name: "agent-slicer-docker-e2e", version: "1.0.0" },
  { versionNegotiation: { mode: "auto" } },
);
const transport = new StreamableHTTPClientTransport(endpoint, {
  requestInit: { headers: { authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const requiredTools = [
    "slicer_status",
    "upload_prepare",
    "project_create",
    "model_import",
    "scene_get",
    "object_transform",
    "object_auto_orient",
    "scene_arrange",
    "scene_render",
    "desktop_capture",
    "presets_list",
    "presets_select",
    "settings_describe",
    "settings_get",
    "settings_apply",
    "slice_start",
    "job_get",
    "gcode_export",
    "project_save",
  ];
  const actualTools = listed.tools.map((tool) => tool.name);
  if (!equalJson(actualTools, requiredTools)) {
    throw new Error(
      `Unexpected ordered tool contract: ${JSON.stringify(actualTools)}`,
    );
  }

  const status = (await call(client, "slicer_status", {})).value;
  if (status.ready !== true) {
    throw new Error(`Slicer bridge is not ready: ${JSON.stringify(status)}`);
  }
  record("MCP connected and native bridge ready", {
    protocol_version: status.protocol_version,
    capabilities: status.capabilities,
  });

  const resources = await client.listResources();
  if (!resources.resources.some((resource) => resource.uri === "agentslicer://docs/upload")) {
    throw new Error(`Upload documentation resource is missing: ${JSON.stringify(resources)}`);
  }
  const uploadGuide = await client.readResource({ uri: "agentslicer://docs/upload" });
  const uploadGuideText = uploadGuide.contents
    .filter((content) => content.uri === "agentslicer://docs/upload" && "text" in content)
    .map((content) => content.text)
    .join("\n");
  if (!uploadGuideText.includes("upload_prepare") || !uploadGuideText.includes("model_import")) {
    throw new Error("Upload documentation resource does not describe the upload/import flow");
  }

  const fixtureBytes = await readFile(fixtureSourcePath);
  const fixtureSha256 = createHash("sha256").update(fixtureBytes).digest("hex");
  const preparedUpload = (await call(client, "upload_prepare", {
    filename: basename(fixtureSourcePath),
    bytes: fixtureBytes.length,
    sha256: fixtureSha256,
  })).value;
  if (!preparedUpload.upload_path.startsWith("/uploads/")) {
    throw new Error(`Upload path is outside MCP routing: ${preparedUpload.upload_path}`);
  }
  const uploadResponse = await fetch(new URL(preparedUpload.upload_path, baseUrl), {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "content-length": String(fixtureBytes.length),
    },
    body: fixtureBytes,
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `Model upload returned ${uploadResponse.status}: ${await uploadResponse.text()}`,
    );
  }
  const uploaded = await uploadResponse.json();
  if (
    uploaded.ok !== true ||
    uploaded.workspace_path !== preparedUpload.workspace_path ||
    uploaded.bytes !== fixtureBytes.length ||
    uploaded.sha256 !== fixtureSha256
  ) {
    throw new Error(`Invalid upload result: ${JSON.stringify(uploaded)}`);
  }
  const fixturePath = preparedUpload.workspace_path;
  record("uploaded fixture through authenticated one-time endpoint", {
    workspace_path: fixturePath,
    bytes: fixtureBytes.length,
    sha256: fixtureSha256,
  });

  let project = (await call(client, "project_create", {})).value;
  await expectToolFailure(
    client,
    "model_import",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      path: "/workspace/../etc/passwd",
    },
    "invalid_path",
    "model import traversal rejected",
  );
  await expectToolFailure(
    client,
    "model_import",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      path: `/workspace/${importSymlinkName}`,
    },
    "invalid_path",
    "model import symlink rejected",
  );
  await expectToolFailure(
    client,
    "model_import",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      path: `/workspace/${oversizedImportName}`,
    },
    "invalid_path",
    "oversized model import rejected",
  );
  const importStarted = (
    await call(client, "model_import", {
      project_id: project.project_id,
      expected_revision: project.revision,
      path: fixturePath,
    })
  ).value;
  const importJob = await waitForJob(client, importStarted.job_id);
  if (
    importJob.type !== "model_import" ||
    importJob.project_id !== project.project_id ||
    importJob.source_revision !== project.revision ||
    importJob.revision !== project.revision + 1 ||
    importJob.metadata === null ||
    Object.keys(importJob.metadata).length !== 0 ||
    importJob.result?.project_id !== project.project_id ||
    importJob.result?.revision !== importJob.revision ||
    !Array.isArray(importJob.result?.object_ids) ||
    importJob.result.object_ids.length === 0
  ) {
    throw new Error(`Invalid completed model_import job: ${JSON.stringify(importJob)}`);
  }
  project = importJob.result;
  let scene = (
    await call(client, "scene_get", {
      project_id: project.project_id,
    })
  ).value;
  if (scene.objects.length === 0 || scene.objects[0].instances.length === 0) {
    throw new Error(`Imported fixture has no object instance: ${JSON.stringify(scene)}`);
  }
  record("created project and imported cube", {
    project_id: project.project_id,
    revision: scene.revision,
    object_ids: project.object_ids,
  });

  const rendered = await call(client, "scene_render", {
    project_id: project.project_id,
    expected_revision: scene.revision,
    views: ["iso", "top", "front"],
    width: 512,
    height: 512,
  });
  if (
    rendered.value.images.length !== 3 ||
    !equalJson(rendered.value.images.map((image) => image.view), ["iso", "top", "front"]) ||
    rendered.value.images.some((image) =>
      image.width !== 512 ||
      image.height !== 512 ||
      image.mime_type !== "image/png"
    )
  ) {
    throw new Error(`Invalid scene render metadata: ${JSON.stringify(rendered.value)}`);
  }
  const initialRenderHashes = await savePngs(rendered.result, "scene-before");
  if (initialRenderHashes.length !== 3 || new Set(initialRenderHashes).size !== 3) {
    throw new Error(`Expected three distinct scene PNGs, received ${initialRenderHashes.length}`);
  }
  const desktop = await call(client, "desktop_capture", {
    project_id: project.project_id,
    expected_revision: scene.revision,
  });
  await savePngs(desktop.result, "desktop");
  record("captured iso, top, front, and desktop PNGs");

  const staleRevision = scene.revision;
  const instance = scene.objects[0].instances[0];
  const targetPosition = {
    x: Number(instance.offset_mm[0]) + 5,
    y: Number(instance.offset_mm[1]) + 3,
    z: Number(instance.offset_mm[2]),
  };
  const targetRotation = {
    x: Number(instance.rotation_deg[0]),
    y: Number(instance.rotation_deg[1]),
    z: Number(instance.rotation_deg[2]) + 15,
  };
  project = (
    await call(client, "object_transform", {
      project_id: project.project_id,
      expected_revision: staleRevision,
      object_id: scene.objects[0].object_id,
      instance_id: instance.instance_id,
      mode: "absolute",
      rotation_deg: targetRotation,
      position_mm: targetPosition,
    })
  ).value;
  await expectToolFailure(
    client,
    "object_transform",
    {
      project_id: project.project_id,
      expected_revision: staleRevision,
      object_id: scene.objects[0].object_id,
      instance_id: instance.instance_id,
      mode: "relative",
      rotation_deg: { x: 0, y: 0, z: 1 },
    },
    "revision_conflict",
    "stale revision rejected",
  );
  scene = (
    await call(client, "scene_get", {
      project_id: project.project_id,
    })
  ).value;
  if (scene.revision !== project.revision) {
    throw new Error(`Scene revision did not match transformed project: ${JSON.stringify(scene)}`);
  }
  const transformed = scene.objects
    .find((object) => object.object_id === scene.objects[0].object_id)
    ?.instances.find((candidate) => candidate.instance_id === instance.instance_id);
  if (
    !transformed ||
    !closeTo(transformed.offset_mm[0], targetPosition.x) ||
    !closeTo(transformed.offset_mm[1], targetPosition.y) ||
    !closeTo(transformed.offset_mm[2], targetPosition.z) ||
    angleDelta(transformed.rotation_deg[0], targetRotation.x) > 0.05 ||
    angleDelta(transformed.rotation_deg[1], targetRotation.y) > 0.05 ||
    angleDelta(transformed.rotation_deg[2], targetRotation.z) > 0.05
  ) {
    throw new Error(
      `Transform did not match the requested delta: ${JSON.stringify({ before: instance, after: transformed })}`,
    );
  }
  const transformedRender = await call(client, "scene_render", {
    project_id: project.project_id,
    expected_revision: scene.revision,
    views: ["iso"],
    width: 512,
    height: 512,
  });
  const transformedHashes = await savePngs(transformedRender.result, "scene-after");
  if (transformedHashes[0] === initialRenderHashes[0]) {
    throw new Error("Scene render did not change after the object transform");
  }
  record("transformed model and enforced optimistic revision");

  const orientSource = { ...project };
  const orientStart = (
    await call(client, "object_auto_orient", {
      project_id: orientSource.project_id,
      expected_revision: orientSource.revision,
      targets: [{
        object_id: scene.objects[0].object_id,
        instance_id: transformed.instance_id,
      }],
    })
  ).value;
  const orientJob = await waitForJob(client, orientStart.job_id);
  if (
    orientJob.type !== "auto_orient" ||
    orientJob.state !== "succeeded" ||
    orientJob.progress !== 1 ||
    orientJob.project_id !== orientSource.project_id ||
    orientJob.source_revision !== orientSource.revision ||
    orientJob.revision !== orientSource.revision + 1 ||
    orientJob.result?.oriented !== true ||
    !Array.isArray(orientJob.warnings) ||
    orientJob.error !== null
  ) {
    throw new Error(`Invalid completed auto-orient job: ${JSON.stringify(orientJob)}`);
  }
  project = {
    project_id: orientSource.project_id,
    revision: orientJob.revision,
  };
  scene = (
    await call(client, "scene_get", { project_id: project.project_id })
  ).value;
  if (scene.revision !== project.revision) {
    throw new Error(`Scene did not refresh to auto-oriented revision: ${JSON.stringify(scene)}`);
  }
  record("auto-oriented the transformed instance", {
    job_id: orientJob.job_id,
    source_revision: orientJob.source_revision,
    revision: orientJob.revision,
  });

  const arrangePresets = (
    await call(client, "presets_list", {
      project_id: project.project_id,
      expected_revision: project.revision,
      compatible_only: false,
    })
  ).value;
  const arrangeSource = {
    project_id: arrangePresets.project_id,
    revision: arrangePresets.revision,
  };
  const arrangeStart = (
    await call(client, "scene_arrange", {
      project_id: arrangeSource.project_id,
      expected_revision: arrangeSource.revision,
    })
  ).value;
  const arrangeJob = await waitForJob(client, arrangeStart.job_id);
  if (
    arrangeJob.type !== "arrange" ||
    arrangeJob.state !== "succeeded" ||
    arrangeJob.progress !== 1 ||
    arrangeJob.project_id !== arrangeSource.project_id ||
    arrangeJob.source_revision !== arrangeSource.revision ||
    arrangeJob.revision !== arrangeSource.revision + 1 ||
    !validConfigSnapshot(
      arrangeJob.metadata?.config_snapshot,
      arrangeSource.revision,
      arrangePresets.selected,
    ) ||
    !Array.isArray(arrangeJob.warnings) ||
    arrangeJob.error !== null ||
    arrangeJob.result?.arranged !== true
  ) {
    throw new Error(`Invalid completed arrange job contract: ${JSON.stringify(arrangeJob)}`);
  }
  project = {
    project_id: arrangeSource.project_id,
    revision: arrangeJob.revision,
  };
  scene = (
    await call(client, "scene_get", {
      project_id: project.project_id,
    })
  ).value;
  if (scene.project_id !== project.project_id || scene.revision !== project.revision) {
    throw new Error(`Scene did not refresh to arranged project revision: ${JSON.stringify(scene)}`);
  }
  record("arranged scene and refreshed the project snapshot", {
    job_id: arrangeJob.job_id,
    source_revision: arrangeJob.source_revision,
    revision: arrangeJob.revision,
  });

  const bootstrapSelection = {
    printer: "Bambu Lab H2S 0.4 nozzle",
    process: "0.20mm Standard @BBL H2S",
    filaments: ["Generic PLA @BBL H2S"],
  };
  let presets = (
    await call(client, "presets_list", {
      project_id: project.project_id,
      expected_revision: scene.revision,
      compatible_only: false,
    })
  ).value;
  project = { project_id: project.project_id, revision: presets.revision };
  for (const [scope, name] of [
    ["printer", bootstrapSelection.printer],
    ["process", bootstrapSelection.process],
    ["filament", bootstrapSelection.filaments[0]],
  ]) {
    if (!presets.presets.some((entry) => entry.scope === scope && entry.name === name)) {
      throw new Error(`Bundled bootstrap ${scope} preset is unavailable: ${name}`);
    }
  }
  const availablePrinterNames = new Set(
    presets.presets
      .filter((entry) => entry.scope === "printer")
      .map((entry) => entry.name),
  );
  const bundledBambuPresets = await bundledBambuPresetNames();
  const missingBambuPrinters = bundledBambuPresets.printers.filter(
    (name) => !availablePrinterNames.has(name),
  );
  if (missingBambuPrinters.length > 0) {
    throw new Error(
      `Bundled Bambu Lab printer presets are unavailable: ${missingBambuPrinters.join(", ")}`,
    );
  }
  const availableFilamentNames = new Set(
    presets.presets
      .filter((entry) => entry.scope === "filament")
      .map((entry) => entry.name),
  );
  const missingGenericFilaments = bundledBambuPresets.genericFilaments.filter(
    (name) => !availableFilamentNames.has(name),
  );
  if (missingGenericFilaments.length > 0) {
    throw new Error(
      `Bundled Bambu-compatible Generic filament profiles are unavailable: ${missingGenericFilaments.join(", ")}`,
    );
  }
  record("listed every bundled Bambu Lab printer and Generic filament profiles", {
    printer_count: bundledBambuPresets.printers.length,
    generic_filament_count: bundledBambuPresets.genericFilaments.length,
  });
  project = (
    await call(client, "presets_select", {
      project_id: project.project_id,
      expected_revision: project.revision,
      selection: bootstrapSelection,
      discard_dirty: false,
    })
  ).value;
  presets = (
    await call(client, "presets_list", {
      project_id: project.project_id,
      expected_revision: project.revision,
      compatible_only: true,
    })
  ).value;
  project = { project_id: project.project_id, revision: presets.revision };
  if (
    presets.selected.printer !== bootstrapSelection.printer ||
    presets.selected.process !== bootstrapSelection.process ||
    !equalJson(presets.selected.filaments, bootstrapSelection.filaments)
  ) {
    throw new Error(
      `Bundled bootstrap preset selection did not stick: ${JSON.stringify(presets.selected)}`,
    );
  }
  const selectedNames = [
    presets.selected.printer,
    presets.selected.process,
    ...presets.selected.filaments,
  ];
  if (selectedNames.some((name) => typeof name !== "string" || /^Default(?:\s|$)/i.test(name))) {
    throw new Error(`Default placeholder remained selected: ${JSON.stringify(presets.selected)}`);
  }
  for (const [scope, name] of [
    ["printer", bootstrapSelection.printer],
    ["process", bootstrapSelection.process],
    ["filament", bootstrapSelection.filaments[0]],
  ]) {
    if (
      !presets.presets.some(
        (entry) => entry.scope === scope && entry.name === name && entry.compatible,
      )
    ) {
      throw new Error(`Selected bootstrap ${scope} preset is not compatible: ${name}`);
    }
  }
  record("selected deterministic bundled printer, process, and filament presets", {
    selected: presets.selected,
  });

  const described = (
    await call(client, "settings_describe", {
      project_id: project.project_id,
      expected_revision: project.revision,
      scopes: ["process"],
      query: "layer_height",
      limit: 200,
    })
  ).value;
  const layerHeight = described.items.find(
    (item) => item.key === "layer_height" && item.scope === "process" && !item.read_only,
  );
  if (!layerHeight) {
    throw new Error("Writable process layer_height descriptor is unavailable");
  }
  const layerHeightSetting = { key: layerHeight.key, scope: layerHeight.scope };
  const currentLayerHeight = (
    await call(client, "settings_get", {
      project_id: project.project_id,
      expected_revision: project.revision,
      settings: [layerHeightSetting],
    })
  ).value.values[0]?.value;
  const changedLayerHeight = changedScalar(layerHeight, currentLayerHeight);
  if (changedLayerHeight === undefined) {
    throw new Error("Could not derive a valid changed layer_height value");
  }
  await expectToolFailure(
    client,
    "settings_apply",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      changes: [
        { ...layerHeightSetting, value: changedLayerHeight },
        {
          key: "__agent_slicer_e2e_invalid__",
          scope: "process",
          value: 1,
        },
      ],
      dry_run: false,
    },
    "invalid_request",
    "invalid mixed settings batch rejected atomically",
  );
  const unchanged = (
    await call(client, "settings_get", {
      project_id: project.project_id,
      expected_revision: project.revision,
      settings: [layerHeightSetting],
    })
  ).value.values[0];
  if (!equalJson(unchanged.value, currentLayerHeight)) {
    throw new Error("Invalid mixed settings batch partially changed a valid setting");
  }
  const applied = (
    await call(client, "settings_apply", {
      project_id: project.project_id,
      expected_revision: project.revision,
      changes: [{ ...layerHeightSetting, value: changedLayerHeight }],
      dry_run: false,
    })
  ).value;
  project = { project_id: project.project_id, revision: applied.revision };
  const changed = (
    await call(client, "settings_get", {
      project_id: project.project_id,
      expected_revision: project.revision,
      settings: [layerHeightSetting],
    })
  ).value.values[0];
  if (!equalJson(changed.value, changedLayerHeight)) {
    throw new Error(
      `Setting readback mismatch: ${JSON.stringify({ expected: changedLayerHeight, actual: changed.value })}`,
    );
  }
  record("enforced atomic settings validation and applied a typed setting", {
    setting: layerHeight.key,
    unit: layerHeight.unit,
  });

  const plateIndex = scene.plates[0]?.plate_index ?? 0;
  const sliceStart = (
    await call(client, "slice_start", {
      project_id: project.project_id,
      expected_revision: project.revision,
      plate_index: plateIndex,
    })
  ).value;
  const sliceJob = await waitForJob(client, sliceStart.job_id);
  assertSucceededJob(sliceJob, "slice", project, bootstrapSelection);
  if (
    sliceJob.result?.sliced !== true ||
    sliceJob.result?.plate_index !== plateIndex ||
    sliceJob.metadata?.plate_index !== plateIndex
  ) {
    throw new Error(`Invalid completed slice result: ${JSON.stringify(sliceJob)}`);
  }
  record("slice completed", { job_id: sliceJob.job_id });

  await expectValidationFailure(
    client,
    "gcode_export",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      slice_job_id: sliceJob.job_id,
      output_path: "../escape.gcode",
    },
    "gcode traversal rejected",
  );
  await expectValidationFailure(
    client,
    "project_save",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      output_path: "/tmp/escape.3mf",
    },
    "absolute output rejected",
  );
  await expectValidationFailure(
    client,
    "project_save",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      output_path: "nested/escape.3mf",
    },
    "nested output rejected",
  );

  const symlinkName = "e2e-symlink.3mf";
  const symlinkPath = resolve(outputsDir, symlinkName);
  await rm(symlinkPath, { force: true });
  await symlink("/tmp/agent-slicer-e2e-escape.3mf", symlinkPath);
  await expectRejectedJob(
    client,
    "project_save",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      output_path: symlinkName,
      overwrite: true,
    },
    "invalid_path",
    "symlink output rejected",
  );
  await rm(symlinkPath, { force: true });

  const gcodeName = "e2e-cube.gcode";
  const projectName = "e2e-cube.3mf";
  await rm(resolve(outputsDir, gcodeName), { force: true });
  await rm(resolve(outputsDir, projectName), { force: true });

  const exportStart = (
    await call(client, "gcode_export", {
      project_id: project.project_id,
      expected_revision: project.revision,
      slice_job_id: sliceJob.job_id,
      output_path: gcodeName,
      overwrite: false,
    })
  ).value;
  const exported = await waitForJob(client, exportStart.job_id);
  assertSucceededJob(exported, "gcode_export", project, bootstrapSelection);
  if (
    exported.result?.path !== `/outputs/${gcodeName}` ||
    !(exported.result?.bytes > 0) ||
    exported.result?.slice_job_id !== sliceJob.job_id ||
    !equalJson(exported.metadata?.config_snapshot, sliceJob.metadata?.config_snapshot)
  ) {
    throw new Error(`Invalid G-code export result: ${JSON.stringify(exported)}`);
  }
  await expectRejectedJob(
    client,
    "gcode_export",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      slice_job_id: sliceJob.job_id,
      output_path: gcodeName,
      overwrite: false,
    },
    "invalid_path",
    "gcode overwrite denied",
  );
  const overwriteExport = (
    await call(client, "gcode_export", {
      project_id: project.project_id,
      expected_revision: project.revision,
      slice_job_id: sliceJob.job_id,
      output_path: gcodeName,
      overwrite: true,
    })
  ).value;
  const overwrittenExport = await waitForJob(client, overwriteExport.job_id);
  assertSucceededJob(overwrittenExport, "gcode_export", project, bootstrapSelection);
  if (
    overwrittenExport.result?.path !== `/outputs/${gcodeName}` ||
    !(overwrittenExport.result?.bytes > 0) ||
    overwrittenExport.result?.slice_job_id !== sliceJob.job_id ||
    !equalJson(overwrittenExport.metadata?.config_snapshot, sliceJob.metadata?.config_snapshot)
  ) {
    throw new Error(`Invalid overwritten G-code result: ${JSON.stringify(overwrittenExport)}`);
  }

  const saveStart = (
    await call(client, "project_save", {
      project_id: project.project_id,
      expected_revision: project.revision,
      output_path: projectName,
      overwrite: false,
    })
  ).value;
  const saved = await waitForJob(client, saveStart.job_id);
  assertSucceededJob(saved, "project_save", project, bootstrapSelection);
  if (saved.result?.path !== `/outputs/${projectName}` || !(saved.result?.bytes > 0)) {
    throw new Error(`Invalid project save result: ${JSON.stringify(saved)}`);
  }
  await expectRejectedJob(
    client,
    "project_save",
    {
      project_id: project.project_id,
      expected_revision: project.revision,
      output_path: projectName,
      overwrite: false,
    },
    "invalid_path",
    "project overwrite denied",
  );
  const overwriteSave = (
    await call(client, "project_save", {
      project_id: project.project_id,
      expected_revision: project.revision,
      output_path: projectName,
      overwrite: true,
    })
  ).value;
  const overwrittenSave = await waitForJob(client, overwriteSave.job_id);
  assertSucceededJob(overwrittenSave, "project_save", project, bootstrapSelection);
  if (
    overwrittenSave.result?.path !== `/outputs/${projectName}` ||
    !(overwrittenSave.result?.bytes > 0)
  ) {
    throw new Error(`Invalid overwritten project result: ${JSON.stringify(overwrittenSave)}`);
  }

  const [gcodeStat, projectStat] = await Promise.all([
    stat(resolve(outputsDir, gcodeName)),
    stat(resolve(outputsDir, projectName)),
  ]);
  if (!gcodeStat.isFile() || gcodeStat.size === 0) {
    throw new Error("Exported G-code is missing or empty");
  }
  if (!projectStat.isFile() || projectStat.size === 0) {
    throw new Error("Saved 3MF is missing or empty");
  }

  const outputHeaders = { authorization: `Bearer ${token}` };
  const outputIndexResponse = await fetch(new URL("outputs/", baseUrl), {
    headers: outputHeaders,
  });
  if (!outputIndexResponse.ok) {
    throw new Error(
      `Output index returned ${outputIndexResponse.status}: ${await outputIndexResponse.text()}`,
    );
  }
  const outputIndex = await outputIndexResponse.json();
  if (
    !Array.isArray(outputIndex.outputs) ||
    !outputIndex.outputs.includes(`/outputs/${gcodeName}`) ||
    !outputIndex.outputs.includes(`/outputs/${projectName}`)
  ) {
    throw new Error(`Output index omitted generated files: ${JSON.stringify(outputIndex)}`);
  }

  for (const [filename, expectedSize] of [
    [gcodeName, gcodeStat.size],
    [projectName, projectStat.size],
  ]) {
    const response = await fetch(new URL(`outputs/${filename}`, baseUrl), {
      headers: outputHeaders,
    });
    const downloaded = Buffer.from(await response.arrayBuffer());
    if (
      !response.ok ||
      downloaded.length !== expectedSize ||
      response.headers.get("content-disposition") !==
        `attachment; filename*=UTF-8''${filename}`
    ) {
      throw new Error(
        `Invalid output download for ${filename}: status=${response.status}, bytes=${downloaded.length}`,
      );
    }
  }
  record("exported non-empty G-code and 3MF with overwrite and path protections", {
    gcode_bytes: gcodeStat.size,
    project_bytes: projectStat.size,
  });

  state.completed_at = new Date().toISOString();
  state.ok = true;
} catch (error) {
  state.completed_at = new Date().toISOString();
  state.ok = false;
  state.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  throw error;
} finally {
  await Promise.all([
    rm(importSymlinkPath, { force: true }),
    rm(oversizedImportPath, { force: true }),
  ]);
  await writeFile(
    resolve(artifactsDir, "e2e-state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
  await client.close().catch(() => {});
}
