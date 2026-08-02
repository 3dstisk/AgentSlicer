import { randomUUID } from "node:crypto";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BridgeError } from "./bridge-client.js";
import { readInternalPng, readPngBuffer, unlinkInternalPng } from "./images.js";
import type { BridgeCaller, DesktopCaptureAdapter } from "./types.js";
import {
  isSupportedUploadFilename,
  UploadError,
  type UploadPreparer,
} from "./uploads.js";

const opaqueId = z.string().min(1).max(128);
const revision = z.number().int().nonnegative();
const maxConfigSnapshotEnvelopeBytes = 512 * 1024;
const settingName = z.string().min(1).max(256);
const unsafeSettingNames = new Set([
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

function safeSettingName(key: string): boolean {
  const normalized = key.toLowerCase();
  return !unsafeSettingNames.has(normalized) &&
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

const safeSettingKey = settingName.refine(
  safeSettingName,
  "Setting is not available through the agent API",
);
const redactedSettingPath = z.string().min(1).max(512).refine(
  (path) => {
    const separator = path.lastIndexOf("/");
    if (separator <= 0) {
      return false;
    }
    const identity = path.slice(0, separator);
    const key = path.slice(separator + 1);
    return key.length <= 256 &&
      !safeSettingName(key) &&
      /^(?:global|object_\d+|object_\d+\/volume_\d+|plate_\d+)$/.test(identity);
  },
  "Redacted setting must be an approved identity path ending in an unsafe key",
);
const project = {
  project_id: opaqueId.describe("Opaque project id returned by project_create"),
};
const projectWithRevision = {
  ...project,
  expected_revision: revision.describe("Reject the operation if the active revision differs"),
};
const projectSnapshot = {
  ...project,
  expected_revision: revision
    .optional()
    .describe("Optionally require this exact project revision for a consistent read"),
};
const configurationScope = z
  .enum(["printer", "process", "filament"])
  .describe("Orca configuration scope: printer hardware, print process, or filament");
const settingScalar = z.union([z.null(), z.boolean(), z.number().finite(), z.string()]);
const floatOrPercent = z
  .object({
    value: z.number().finite(),
    percent: z.boolean(),
  })
  .strict();
const settingAtom = z.union([settingScalar, floatOrPercent]);
const settingValue = z.union([
  settingAtom,
  z.array(settingAtom),
  z.array(z.array(settingAtom)),
  z.array(z.array(z.array(settingAtom))),
]);
const presetSelection = z
  .object({
    printer: opaqueId.optional().describe("Exact printer preset name"),
    process: opaqueId.optional().describe("Exact process preset name"),
    filaments: z
      .array(opaqueId)
      .min(1)
      .max(64)
      .optional()
      .describe("Exact filament preset name for each extruder, in extruder order"),
  })
  .strict();
const settingKeyFields = {
  key: safeSettingKey.describe("Exact safe Orca configuration key returned by settings_describe"),
  scope: configurationScope,
  filament_index: z
    .number()
    .int()
    .min(0)
    .max(63)
    .optional()
    .describe("Zero-based selected filament/extruder slot; defaults to 0 for filament scope"),
};
const settingKey = z
  .object(settingKeyFields)
  .strict()
  .superRefine((entry, context) => {
    if (entry.scope !== "filament" && entry.filament_index !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["filament_index"],
        message: "filament_index is only valid for filament scope",
      });
    }
  });
const settingChange = z
  .object({
    ...settingKeyFields,
    value: settingValue.describe(
      "Typed JSON value matching settings_describe; units are declared by that descriptor",
    ),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.scope !== "filament" && entry.filament_index !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["filament_index"],
        message: "filament_index is only valid for filament scope",
      });
    }
  });

function settingIdentity(entry: {
  scope: string;
  key: string;
  filament_index?: number;
}): string {
  return `${entry.scope}\0${entry.key}\0${
    entry.scope === "filament" ? (entry.filament_index ?? 0) : 0
  }`;
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}
const vector3 = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();
const scale3 = z
  .object({
    x: z.number().positive().finite(),
    y: z.number().positive().finite(),
    z: z.number().positive().finite(),
  })
  .strict();
const unsignedSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

function outputPath(extension: ".gcode" | ".3mf") {
  return z
    .string()
    .min(1)
    .max(1024)
    .superRefine((path, context) => {
      if (path.includes("\0")) {
        context.addIssue({ code: "custom", message: "output_path must not contain NUL" });
      }
      if (path.startsWith("/")) {
        context.addIssue({ code: "custom", message: "output_path must be relative" });
      }
      if (path === "." || path === "..") {
        context.addIssue({
          code: "custom",
          message: "output_path must not be dot or dot-dot",
        });
      }
      if (path.includes("/") || path.includes("\\")) {
        context.addIssue({
          code: "custom",
          message: "output_path must be a root-level filename without path separators",
        });
      }
      if (!path.endsWith(extension)) {
        context.addIssue({
          code: "custom",
          message: `output_path must have the exact ${extension} extension`,
        });
      }
    })
    .describe(`Root-level filename beneath /outputs ending in ${extension}`);
}

function artifactPath(extension: ".gcode" | ".3mf") {
  return z
    .string()
    .min(1)
    .max(4096)
    .superRefine((path, context) => {
      if (path.includes("\0")) {
        context.addIssue({ code: "custom", message: "artifact path must not contain NUL" });
      }
      if (!path.startsWith("/outputs/")) {
        context.addIssue({
          code: "custom",
          message: "artifact path must be absolute and beneath /outputs",
        });
      }
      if (path.split("/").some((segment) => segment === "." || segment === "..")) {
        context.addIssue({
          code: "custom",
          message: "artifact path must not contain dot or dot-dot path segments",
        });
      }
      if (!path.endsWith(extension)) {
        context.addIssue({
          code: "custom",
          message: `artifact path must have the exact ${extension} extension`,
        });
      }
    });
}

export const toolSchemas = {
  slicer_status: z.object({}).strict(),
  upload_prepare: z
    .object({
      filename: z
        .string()
        .min(1)
        .max(255)
        .refine(
          isSupportedUploadFilename,
          "filename must be a root-level STL, OBJ, or 3MF filename",
        ),
      bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    })
    .strict(),
  project_create: z.object({}).strict(),
  model_import: z
    .object({
      ...projectWithRevision,
      path: z
        .string()
        .startsWith("/workspace/")
        .describe("Absolute model path beneath /workspace"),
    })
    .strict(),
  scene_get: z.object(project).strict(),
  object_transform: z
    .object({
      ...projectWithRevision,
      object_id: opaqueId,
      instance_id: opaqueId,
      mode: z.enum(["absolute", "relative"]).default("absolute"),
      position_mm: vector3.optional(),
      rotation_deg: vector3.optional(),
      scale: z.union([z.number().positive().finite(), scale3]).optional(),
      place_on_bed: z.boolean().optional(),
    })
    .strict()
    .refine(
      (value) =>
        value.position_mm !== undefined ||
        value.rotation_deg !== undefined ||
        value.scale !== undefined ||
        value.place_on_bed === true,
      { message: "At least one transform field is required" },
    ),
  scene_arrange: z.object(projectWithRevision).strict(),
  presets_list: z
    .object({
      ...projectSnapshot,
      scopes: z
        .array(configurationScope)
        .min(1)
        .max(3)
        .refine((scopes) => uniqueBy(scopes, String), "Preset scopes must be unique")
        .optional(),
      compatible_only: z
        .boolean()
        .default(true)
        .describe("Exclude presets Orca marks incompatible with the active selection"),
    })
    .strict(),
  presets_select: z
    .object({
      ...projectWithRevision,
      selection: presetSelection.refine(
        (selection) =>
          selection.printer !== undefined ||
          selection.process !== undefined ||
          selection.filaments !== undefined,
        "At least one preset selection is required",
      ),
      discard_dirty: z
        .boolean()
        .default(false)
        .describe("Deliberately discard unsaved preset edits before validating and selecting"),
    })
    .strict(),
  settings_describe: z
    .object({
      ...projectSnapshot,
      query: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("Case-insensitive key, label, and description filter"),
      scopes: z
        .array(configurationScope)
        .min(1)
        .max(3)
        .refine((scopes) => uniqueBy(scopes, String), "Setting scopes must be unique")
        .optional(),
      cursor: opaqueId
        .optional()
        .describe("Opaque continuation cursor returned by the previous page"),
      limit: z.number().int().min(1).max(200).default(100),
    })
    .strict(),
  settings_get: z
    .object({
      ...projectSnapshot,
      settings: z
        .array(settingKey)
        .min(1)
        .max(256)
        .refine(
          (settings) => uniqueBy(settings, settingIdentity),
          "Setting keys must be unique within each scope and filament slot",
        ),
    })
    .strict(),
  settings_apply: z
    .object({
      ...projectWithRevision,
      changes: z
        .array(settingChange)
        .min(1)
        .max(256)
        .refine(
          (changes) => uniqueBy(changes, settingIdentity),
          "Setting changes must be unique within each scope and filament slot",
        ),
      dry_run: z
        .boolean()
        .default(false)
        .describe("Validate the complete batch without changing presets or project revision"),
    })
    .strict(),
  slice_start: z
    .object({
      ...projectWithRevision,
      plate_index: unsignedSafeInteger,
    })
    .strict(),
  job_get: z.object({ job_id: opaqueId }).strict(),
  gcode_export: z
    .object({
      ...projectWithRevision,
      slice_job_id: opaqueId,
      output_path: outputPath(".gcode"),
      overwrite: z.boolean().default(false),
    })
    .strict(),
  project_save: z
    .object({
      ...projectWithRevision,
      output_path: outputPath(".3mf"),
      overwrite: z.boolean().default(false),
    })
    .strict(),
  scene_render: z
    .object({
      ...project,
      expected_revision: revision.optional(),
      views: z
        .array(z.enum(["iso", "top", "front", "rear", "left", "right", "bottom", "top_front"]))
        .min(1)
        .max(6)
        .refine((views) => new Set(views).size === views.length, {
          message: "Render views must be unique",
        }),
      width: z.number().int().min(64).max(2048).default(1024),
      height: z.number().int().min(64).max(2048).default(1024),
    })
    .strict(),
  desktop_capture: z
    .object({
      ...project,
      expected_revision: revision.optional(),
    })
    .strict(),
} as const;

export const toolNames = [
  "slicer_status",
  "upload_prepare",
  "project_create",
  "model_import",
  "scene_get",
  "object_transform",
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
] as const;

type ToolName = (typeof toolNames)[number];
type BridgeToolName = Exclude<ToolName, "upload_prepare">;

export interface ToolDependencies {
  bridge: BridgeCaller;
  desktopCapture: DesktopCaptureAdapter;
  screenshotRoots: readonly string[];
  desktopScreenshotRoot: string;
  maxImageBytes: number;
  readPng?: typeof readInternalPng;
  removePng?: typeof unlinkInternalPng;
}

export interface AgentToolDependencies extends ToolDependencies {
  uploads: UploadPreparer;
}

const descriptions: Record<ToolName, string> = {
  slicer_status: "Report native Orca bridge readiness, active project, revision, jobs, and capabilities.",
  upload_prepare:
    "Create a single-use authenticated HTTP upload ticket for a local STL, OBJ, or 3MF file. PUT the raw bytes to the returned same-origin upload_path, then pass workspace_path to model_import. Detailed guidance is available at agentslicer://docs/upload.",
  project_create: "Reset Orca to a new empty project and return its opaque project id and revision.",
  model_import:
    "Import an STL, 3MF, or OBJ model already present beneath /workspace. For local client files, call upload_prepare and complete its HTTP PUT first; see agentslicer://docs/upload.",
  scene_get: "Inspect objects, instances, transforms, bounds, plates, and the current revision.",
  object_transform: "Move, rotate, scale, or place one model instance on the bed.",
  scene_arrange: "Start Orca's native arrange operation for the active project.",
  scene_render: "Render one to six clean PNG views of the active scene for visual reasoning.",
  desktop_capture: "Capture the complete Orca desktop for diagnostics, including modal dialogs.",
  presets_list:
    "List exact printer, process, and filament preset names and Orca's compatibility/selection state. Scopes are printer hardware, print process, and filament.",
  presets_select:
    "Atomically select exact preset names. Printer and process are single presets; filaments are ordered by extruder. Exact already-selected names are revision-neutral. discard_dirty must be explicit before unsaved edits are discarded.",
  settings_describe:
    "Discover paginated Orca settings by key, label, description, or scope. Each result declares its native value type, scope, editability, unit text, numeric limits, and enum values; never infer units or values.",
  settings_get:
    "Read typed effective values for exact setting keys and scopes. Use filament_index for a selected extruder slot. Float-or-percent values are {value, percent}; points and point groups are nested numeric arrays.",
  settings_apply:
    "Validate and atomically apply typed JSON setting changes in printer, process, or filament scope (using filament_index for an extruder slot). Float-or-percent values are {value, percent}; points and point groups are nested numeric arrays. dry_run validates the entire batch without mutation.",
  slice_start: "Start slicing one zero-based plate and return immediately with a running job.",
  job_get: "Get the current state, progress, result, and error for an asynchronous job.",
  gcode_export:
    "Export a successful slice job to a root-level .gcode filename beneath /outputs.",
  project_save: "Save the active project to a root-level .3mf filename beneath /outputs.",
};

const projectResultSchema = z.object({ project_id: opaqueId, revision }).strict();
const boundsSchema = z
  .object({
    min_mm: z.array(z.number().finite()).length(3),
    max_mm: z.array(z.number().finite()).length(3),
    size_mm: z.array(z.number().finite()).length(3),
  })
  .strict()
  .nullable();
const sceneResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    objects: z.array(
      z.object({
        object_id: opaqueId,
        object_index: z.number().int().nonnegative(),
        name: z.string(),
        bounds: boundsSchema,
        instances: z.array(
          z.object({
            instance_id: opaqueId,
            instance_index: z.number().int().nonnegative(),
            offset_mm: z.array(z.number().finite()).length(3),
            rotation_deg: z.array(z.number().finite()).length(3),
            scale: z.array(z.number().positive().finite()).length(3),
            bounds: boundsSchema,
            plate_index: z.number().int(),
          }).strict(),
        ),
      }).strict(),
    ),
    plates: z.array(
      z.object({
        plate_index: z.number().int().nonnegative(),
        name: z.string(),
        origin_mm: z.array(z.number().finite()).length(3).nullable(),
        size_mm: z.array(z.number().finite()).length(3),
      }).strict(),
    ),
  })
  .strict();
const statusResultSchema = z
  .object({
    ready: z.boolean(),
    protocol_version: z.number().int().positive(),
    project_id: opaqueId.nullable(),
    revision,
    job_count: z.number().int().nonnegative(),
    capabilities: z.array(z.string()),
  })
  .strict();
const uploadPreparationResultSchema = z
  .object({
    upload_id: opaqueId,
    upload_path: z.string().startsWith("/uploads/"),
    workspace_path: z.string().startsWith("/workspace/uploads/"),
    filename: z.string(),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    method: z.literal("PUT"),
    content_type: z.literal("application/octet-stream"),
    expires_at: z.string().datetime(),
    required_headers: z
      .object({
        authorization: z.literal("Bearer <same token used for MCP>"),
        content_type: z.literal("application/octet-stream"),
        content_length: z.string().regex(/^\d+$/),
      })
      .strict(),
  })
  .strict();
const importResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    object_ids: z.array(opaqueId),
  })
  .strict();
const runningJobStartResultSchema = z
  .object({
    job_id: opaqueId,
    state: z.literal("running"),
  })
  .strict();
// Native import and save register the job before starting the Orca operation.
// A startup exception therefore returns the registered job in its terminal
// failed state, so an agent can retrieve the stable error through job_get.
const registeredJobStartResultSchema = z
  .object({
    job_id: opaqueId,
    state: z.union([z.literal("running"), z.literal("failed")]),
  })
  .strict();
const selectedPresetsSchema = z
  .object({
    printer: opaqueId.nullable(),
    process: opaqueId.nullable(),
    filaments: z.array(opaqueId).max(64),
  })
  .strict();
const presetEntrySchema = z
  .object({
    scope: configurationScope,
    name: opaqueId,
    selected: z.boolean(),
    compatible: z.boolean(),
  })
  .strict();
const presetsListResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    selected: selectedPresetsSchema,
    presets: z.array(presetEntrySchema),
  })
  .strict();
const presetsSelectResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    selected: selectedPresetsSchema,
  })
  .strict();
const settingDescriptorSchema = z
  .object({
    key: safeSettingKey,
    scope: configurationScope,
    label: z.string(),
    description: z.string(),
    type: z
      .string()
      .min(1)
      .describe("Native Orca configuration value type; clients must not guess coercions"),
    nullable: z.boolean(),
    read_only: z.boolean(),
    unit: z.string().nullable(),
    min: z.number().finite().nullable(),
    max: z.number().finite().nullable(),
    max_literal: z.number().finite().nullable(),
    enum_values: z.array(settingScalar).nullable(),
  })
  .strict();
const settingsDescribeResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    items: z.array(settingDescriptorSchema),
    next_cursor: opaqueId.nullable(),
  })
  .strict();
const settingResultSchema = z
  .object({
    ...settingKeyFields,
    value: settingValue,
    unit: z.string().nullable(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.scope === "filament" && entry.filament_index === undefined) {
      context.addIssue({
        code: "custom",
        path: ["filament_index"],
        message: "Native filament setting result must identify its filament slot",
      });
    }
    if (entry.scope !== "filament" && entry.filament_index !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["filament_index"],
        message: "Non-filament setting result must not include filament_index",
      });
    }
  });
const settingsGetResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    values: z.array(settingResultSchema),
  })
  .strict();
const appliedSettingSchema = z
  .object({
    ...settingKeyFields,
    value: settingValue,
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.scope === "filament" && entry.filament_index === undefined) {
      context.addIssue({
        code: "custom",
        path: ["filament_index"],
        message: "Native filament applied result must identify its filament slot",
      });
    }
    if (entry.scope !== "filament" && entry.filament_index !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["filament_index"],
        message: "Non-filament applied result must not include filament_index",
      });
    }
  });
const settingsApplyResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    dry_run: z.boolean(),
    applied: z.array(appliedSettingSchema).min(1),
  })
  .strict();
const jobStateSchema = z.enum(["queued", "running", "succeeded", "failed", "cancelled"]);
const jobWarningSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().nullable(),
  })
  .strict();
const jobErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().nullable(),
  })
  .strict();
// Native bounds each value and the entire canonical/response snapshot by bytes,
// rather than imposing an artificial count cap on settings or redactions.
const snapshotSettingsSchema = z
  .record(safeSettingKey, z.string().max(65_536));
const configOverrideSchema = z
  .object({
    kind: z.enum(["object", "volume", "plate"]),
    identity: z.string().min(1).max(256),
    settings: snapshotSettingsSchema,
    effective_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine((override, context) => {
    const identityMatches = override.kind === "object"
      ? /^object_\d+$/.test(override.identity)
      : override.kind === "volume"
        ? /^object_\d+\/volume_\d+$/.test(override.identity)
        : /^plate_\d+$/.test(override.identity);
    if (!identityMatches) {
      context.addIssue({
        code: "custom",
        path: ["identity"],
        message: "Configuration override identity does not match its kind",
      });
    }
  });
function stableOverrideOrder(
  overrides: readonly z.infer<typeof configOverrideSchema>[],
): boolean {
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
const configSnapshotSchema = z
  .object({
    schema_version: z.literal(2),
    revision,
    presets: selectedPresetsSchema,
    settings: snapshotSettingsSchema,
    overrides: z
      .array(configOverrideSchema)
      .max(4096)
      .refine(
        (overrides) =>
          new Set(overrides.map((override) => override.identity)).size === overrides.length,
        "Configuration override identities must be unique",
      )
      .refine(stableOverrideOrder, "Configuration overrides must use stable native order"),
    redacted_keys: z
      .array(redactedSettingPath)
      .refine(
        (keys) =>
          new Set(keys).size === keys.length &&
          keys.every((key, index) => index === 0 || keys[index - 1]! < key),
        "Redacted setting keys must be unique and sorted",
      ),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive().max(524_288),
  })
  .strict()
  .superRefine((snapshot, context) => {
    // The native controller adds revision and presets before publishing this
    // object, then caps that final JSON envelope at 512 KiB. Mirror that final
    // boundary here rather than trusting only snapshot.bytes (the inner
    // canonical configuration size).
    if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > maxConfigSnapshotEnvelopeBytes) {
      context.addIssue({
        code: "custom",
        message: "Configuration snapshot response exceeds 512 KiB",
      });
    }
  });
const jobBase = {
  job_id: opaqueId,
  state: jobStateSchema,
  progress: z.number().min(0).max(1),
  project_id: opaqueId.nullable(),
  source_revision: revision.nullable(),
  warnings: z.array(jobWarningSchema),
  error: jobErrorSchema.nullable(),
  revision,
};
const arrangeJobSchema = z
  .object({
    ...jobBase,
    type: z.literal("arrange"),
    metadata: z
      .object({
        config_snapshot: configSnapshotSchema,
      })
      .strict(),
    result: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
const modelImportJobSchema = z
  .object({
    ...jobBase,
    type: z.literal("model_import"),
    metadata: z.object({}).strict(),
    result: importResultSchema.nullable(),
  })
  .strict();
const sliceJobSchema = z
  .object({
    ...jobBase,
    type: z.literal("slice"),
    metadata: z
      .object({
        plate_index: unsignedSafeInteger,
        config_snapshot: configSnapshotSchema,
      })
      .strict(),
    result: z
      .object({
        plate_index: unsignedSafeInteger,
        sliced: z.literal(true),
      })
      .strict()
      .nullable(),
  })
  .strict();
const gcodeExportJobSchema = z
  .object({
    ...jobBase,
    type: z.literal("gcode_export"),
    metadata: z
      .object({
        slice_job_id: opaqueId,
        output_path: outputPath(".gcode"),
        config_snapshot: configSnapshotSchema,
      })
      .strict(),
    result: z
      .object({
        path: artifactPath(".gcode"),
        bytes: z.number().int().nonnegative(),
        slice_job_id: opaqueId,
      })
      .strict()
      .nullable(),
  })
  .strict();
const projectSaveJobSchema = z
  .object({
    ...jobBase,
    type: z.literal("project_save"),
    metadata: z
      .object({
        output_path: outputPath(".3mf"),
        config_snapshot: configSnapshotSchema.optional(),
      })
      .strict(),
    result: z
      .object({
        path: artifactPath(".3mf"),
        bytes: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((job, context) => {
    // Native snapshot preparation is bounded and completes before save startup.
    // Only a registered preflight failure can therefore omit the snapshot.
    const mayOmitSnapshot = job.state === "failed" && job.progress === 0;
    if (job.metadata.config_snapshot === undefined && !mayOmitSnapshot) {
      context.addIssue({
        code: "custom",
        path: ["metadata", "config_snapshot"],
        message: "Project save snapshot may be absent only after a preflight failure",
      });
    }
  });
export const jobResultSchema = z.discriminatedUnion("type", [
  arrangeJobSchema,
  modelImportJobSchema,
  sliceJobSchema,
  gcodeExportJobSchema,
  projectSaveJobSchema,
]);

function objectResult(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value };
}

function successResult(value: unknown): CallToolResult {
  const structuredContent = objectResult(value);
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function toArray(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const vector = value as Record<string, unknown>;
  return [vector.x, vector.y, vector.z];
}

function toPublicRenderView(view: string): string {
  return view === "topfront" ? "top_front" : view;
}

function replacementConflictDuringDesktopCapture(
  preCaptureProjectState: z.infer<typeof projectResultSchema>,
  error: BridgeError,
): BridgeError {
  const nativeDetails = typeof error.details === "object" && error.details !== null
    ? error.details as Record<string, unknown>
    : {};
  return new BridgeError({
    code: "revision_conflict",
    message: "Project changed during desktop capture",
    details: {
      expected_project_id: preCaptureProjectState.project_id,
      actual_project_id: nativeDetails.actual_project_id ?? nativeDetails.active_project_id ?? null,
      expected_revision: preCaptureProjectState.revision,
      actual_revision: nativeDetails.actual_revision ?? nativeDetails.active_revision ?? null,
    },
  });
}

/**
 * The MCP contract uses named vector components and a readable top_front view.
 * Keep the native bridge's compact array/topfront representation isolated here.
 */
export function toBridgeParams(
  method: BridgeToolName | "project_get",
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (method === "object_transform") {
    const { position_mm, rotation_deg, scale, ...rest } = params;
    return {
      ...rest,
      ...(position_mm !== undefined ? { offset_mm: toArray(position_mm) } : {}),
      ...(rotation_deg !== undefined ? { rotation_deg: toArray(rotation_deg) } : {}),
      ...(scale !== undefined
        ? {
            scale:
              typeof scale === "number" ? [scale, scale, scale] : toArray(scale),
          }
        : {}),
    };
  }
  if (method === "scene_render" && Array.isArray(params.views)) {
    return {
      ...params,
      views: params.views.map((view) => (view === "top_front" ? "topfront" : view)),
    };
  }
  return params;
}

export function toolErrorResult(error: unknown): CallToolResult {
  const payload =
    error instanceof BridgeError
      ? {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {}),
        }
      : error instanceof UploadError
        ? {
            code: error.code,
            message: error.message,
          }
        : {
          code: "mcp_adapter_error",
          message: error instanceof Error ? error.message : String(error),
        };
  const structuredContent = { ok: false, error: payload };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

async function bridgeTool(
  dependencies: ToolDependencies,
  method: BridgeToolName,
  params: Record<string, unknown>,
  resultSchema: z.ZodType<Record<string, unknown>>,
): Promise<CallToolResult> {
  try {
    const result = await dependencies.bridge.call(method, toBridgeParams(method, params));
    return successResult(resultSchema.parse(result));
  } catch (error) {
    return toolErrorResult(error);
  }
}

const renderResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    images: z
      .array(
        z
          .object({
            path: z.string(),
            view: z.string(),
            width: z.number().int().positive().optional(),
            height: z.number().int().positive().optional(),
            mime_type: z.literal("image/png"),
            bytes: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1)
      .max(6),
  })
  .strict();

const mcpRenderResultSchema = z.object({
  project_id: opaqueId,
  revision,
  images: z.array(z.object({
    path: z.string(),
    view: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().positive(),
    mime_type: z.literal("image/png"),
  }).strict()).min(1).max(6),
}).strict();

const desktopResultSchema = z.object({
  project_id: opaqueId,
  revision,
  image: z.object({
    path: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().positive(),
    mime_type: z.literal("image/png"),
    diagnostic: z.literal(true),
  }).strict(),
}).strict();

async function sceneRender(
  dependencies: ToolDependencies,
  params: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const nativeParams = toBridgeParams("scene_render", params);
    const bridgeResult = renderResultSchema.parse(
      await dependencies.bridge.call("scene_render", nativeParams),
    );
    const capturedIdentities = new Map<
      string,
      Awaited<ReturnType<typeof readInternalPng>>["fileIdentity"]
    >();
    try {
      const readPng = dependencies.readPng ?? readInternalPng;
      const requestedWidth = nativeParams.width as number;
      const requestedHeight = nativeParams.height as number;
      const requestedViews = nativeParams.views as string[];
      if (bridgeResult.images.length !== requestedViews.length) {
        throw new Error("Native render returned a different image count than requested");
      }
      if (new Set(bridgeResult.images.map((image) => image.view)).size !==
          bridgeResult.images.length) {
        throw new Error("Native render returned duplicate views");
      }
      const settledImages = await Promise.allSettled(
        bridgeResult.images.map(async (image, index) => {
          if (image.width !== requestedWidth || image.height !== requestedHeight ||
              image.view !== requestedViews[index]) {
            throw new Error("Native render metadata does not match the requested render");
          }
          const png = await readPng(
            image.path,
            dependencies.screenshotRoots,
            dependencies.maxImageBytes,
          );
          // readInternalPng returned a descriptor-pinned, fully parsed PNG, so
          // cleanup may now be tied to this exact file snapshot even if later
          // semantic checks reject its dimensions.
          capturedIdentities.set(image.path, png.fileIdentity);
          if (png.width !== requestedWidth || png.height !== requestedHeight) {
            throw new Error("Rendered PNG dimensions do not match the requested render");
          }
          return { metadata: { ...image, view: toPublicRenderView(image.view) }, png };
        }),
      );
      // Every task must settle before cleanup snapshots capturedIdentities. A
      // fast validation error must not leave a slower, already-opened PNG
      // orphaned after it later records its pinned file identity.
      const failedImage = settledImages.find((result) => result.status === "rejected");
      if (failedImage?.status === "rejected") {
        throw failedImage.reason;
      }
      const images = settledImages.map((result) => {
        if (result.status !== "fulfilled") {
          throw new Error("Rendered PNG validation did not settle");
        }
        return result.value;
      });
      const structuredContent = mcpRenderResultSchema.parse({
        ...bridgeResult,
        images: images.map(({ metadata, png }) => ({
          ...metadata,
          path: png.path,
          width: png.width,
          height: png.height,
          bytes: png.bytes,
          mime_type: png.mimeType,
        })),
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(structuredContent) },
          ...images.map(({ png }) => ({
            type: "image" as const,
            data: png.data,
            mimeType: png.mimeType,
          })),
        ],
        structuredContent,
      };
    } finally {
      await Promise.all(
        [...capturedIdentities].map(([path, expectedFile]) => {
          return (dependencies.removePng ?? unlinkInternalPng)(
            path,
            dependencies.screenshotRoots,
            { expectedFile },
          );
        }),
      );
    }
  } catch (error) {
    return toolErrorResult(error);
  }
}

async function desktopCapture(
  dependencies: ToolDependencies,
  params: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    // Check the requested project/revision before the potentially slow desktop
    // capture, then check it again before attaching project metadata to bytes
    // that may be up to a minute old.
    const preCaptureProjectState = projectResultSchema.parse(objectResult(
      await dependencies.bridge.call("project_get", toBridgeParams("project_get", params)),
    ));
    const filename = `mcp-desktop-${randomUUID()}.png`;
    const captured = await dependencies.desktopCapture.capture(filename);
    const png = readPngBuffer(captured.data, captured.path, dependencies.maxImageBytes);
    let projectState: z.infer<typeof projectResultSchema>;
    try {
      projectState = projectResultSchema.parse(objectResult(
        await dependencies.bridge.call("project_get", toBridgeParams("project_get", params)),
      ));
    } catch (error) {
      if (error instanceof BridgeError && error.code === "project_not_found") {
        throw replacementConflictDuringDesktopCapture(preCaptureProjectState, error);
      }
      throw error;
    }
    if (projectState.project_id !== preCaptureProjectState.project_id ||
        projectState.revision !== preCaptureProjectState.revision) {
      throw new BridgeError({
        code: "revision_conflict",
        message: "Project changed during desktop capture",
        details: {
          expected_project_id: preCaptureProjectState.project_id,
          actual_project_id: projectState.project_id,
          expected_revision: preCaptureProjectState.revision,
          actual_revision: projectState.revision,
        },
      });
    }
    const structuredContent = desktopResultSchema.parse({
      ...projectState,
      image: {
        path: png.path,
        width: png.width,
        height: png.height,
        bytes: png.bytes,
        mime_type: png.mimeType,
        diagnostic: true,
      },
    });
    return {
      content: [
        { type: "text", text: JSON.stringify(structuredContent) },
        { type: "image", data: png.data, mimeType: png.mimeType },
      ],
      structuredContent,
    };
  } catch (error) {
    return toolErrorResult(error);
  }
}

export function registerAgentTools(server: McpServer, dependencies: AgentToolDependencies): void {
  server.registerTool(
    "slicer_status",
    {
      description: descriptions.slicer_status,
      inputSchema: toolSchemas.slicer_status,
      outputSchema: statusResultSchema,
    },
    () => bridgeTool(dependencies, "slicer_status", {}, statusResultSchema),
  );
  server.registerTool(
    "upload_prepare",
    {
      description: descriptions.upload_prepare,
      inputSchema: toolSchemas.upload_prepare,
      outputSchema: uploadPreparationResultSchema,
    },
    async (params) => {
      try {
        const prepared = await dependencies.uploads.prepare(params);
        return successResult(uploadPreparationResultSchema.parse(prepared));
      } catch (error) {
        return toolErrorResult(error);
      }
    },
  );
  server.registerTool(
    "project_create",
    {
      description: descriptions.project_create,
      inputSchema: toolSchemas.project_create,
      outputSchema: projectResultSchema,
    },
    () => bridgeTool(dependencies, "project_create", {}, projectResultSchema),
  );
  server.registerTool(
    "model_import",
    {
      description: descriptions.model_import,
      inputSchema: toolSchemas.model_import,
      outputSchema: registeredJobStartResultSchema,
    },
    (params) => bridgeTool(dependencies, "model_import", params, registeredJobStartResultSchema),
  );
  server.registerTool(
    "scene_get",
    {
      description: descriptions.scene_get,
      inputSchema: toolSchemas.scene_get,
      outputSchema: sceneResultSchema,
    },
    (params) => bridgeTool(dependencies, "scene_get", params, sceneResultSchema),
  );
  server.registerTool(
    "object_transform",
    {
      description: descriptions.object_transform,
      inputSchema: toolSchemas.object_transform,
      outputSchema: projectResultSchema,
    },
    (params) => bridgeTool(dependencies, "object_transform", params, projectResultSchema),
  );
  server.registerTool(
    "scene_arrange",
    {
      description: descriptions.scene_arrange,
      inputSchema: toolSchemas.scene_arrange,
      outputSchema: runningJobStartResultSchema,
    },
    (params) => bridgeTool(dependencies, "scene_arrange", params, runningJobStartResultSchema),
  );
  server.registerTool(
    "scene_render",
    {
      description: descriptions.scene_render,
      inputSchema: toolSchemas.scene_render,
      outputSchema: mcpRenderResultSchema,
    },
    (params) => sceneRender(dependencies, params),
  );
  server.registerTool(
    "desktop_capture",
    {
      description: descriptions.desktop_capture,
      inputSchema: toolSchemas.desktop_capture,
      outputSchema: desktopResultSchema,
    },
    (params) => desktopCapture(dependencies, params),
  );
  server.registerTool(
    "presets_list",
    {
      description: descriptions.presets_list,
      inputSchema: toolSchemas.presets_list,
      outputSchema: presetsListResultSchema,
    },
    (params) => bridgeTool(dependencies, "presets_list", params, presetsListResultSchema),
  );
  server.registerTool(
    "presets_select",
    {
      description: descriptions.presets_select,
      inputSchema: toolSchemas.presets_select,
      outputSchema: presetsSelectResultSchema,
    },
    (params) => bridgeTool(dependencies, "presets_select", params, presetsSelectResultSchema),
  );
  server.registerTool(
    "settings_describe",
    {
      description: descriptions.settings_describe,
      inputSchema: toolSchemas.settings_describe,
      outputSchema: settingsDescribeResultSchema,
    },
    (params) =>
      bridgeTool(dependencies, "settings_describe", params, settingsDescribeResultSchema),
  );
  server.registerTool(
    "settings_get",
    {
      description: descriptions.settings_get,
      inputSchema: toolSchemas.settings_get,
      outputSchema: settingsGetResultSchema,
    },
    (params) => bridgeTool(dependencies, "settings_get", params, settingsGetResultSchema),
  );
  server.registerTool(
    "settings_apply",
    {
      description: descriptions.settings_apply,
      inputSchema: toolSchemas.settings_apply,
      outputSchema: settingsApplyResultSchema,
    },
    (params) => bridgeTool(dependencies, "settings_apply", params, settingsApplyResultSchema),
  );
  server.registerTool(
    "slice_start",
    {
      description: descriptions.slice_start,
      inputSchema: toolSchemas.slice_start,
      outputSchema: runningJobStartResultSchema,
    },
    (params) => bridgeTool(dependencies, "slice_start", params, runningJobStartResultSchema),
  );
  server.registerTool(
    "job_get",
    {
      description: descriptions.job_get,
      inputSchema: toolSchemas.job_get,
      outputSchema: jobResultSchema,
    },
    (params) => bridgeTool(dependencies, "job_get", params, jobResultSchema),
  );
  server.registerTool(
    "gcode_export",
    {
      description: descriptions.gcode_export,
      inputSchema: toolSchemas.gcode_export,
      outputSchema: runningJobStartResultSchema,
    },
    (params) => bridgeTool(dependencies, "gcode_export", params, runningJobStartResultSchema),
  );
  server.registerTool(
    "project_save",
    {
      description: descriptions.project_save,
      inputSchema: toolSchemas.project_save,
      outputSchema: registeredJobStartResultSchema,
    },
    (params) => bridgeTool(dependencies, "project_save", params, registeredJobStartResultSchema),
  );
}
