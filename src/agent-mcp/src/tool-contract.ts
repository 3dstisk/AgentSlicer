import { randomUUID } from "node:crypto";

import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { BridgeError } from "./bridge-client.js";
import { logApiFailure } from "./diagnostics.js";
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
/** Unique object instances, as returned by scene_get. */
const instanceTargets = z
  .array(z.object({ object_id: opaqueId, instance_id: opaqueId }).strict())
  .min(1)
  .max(1024)
  .refine(
    (targets) =>
      new Set(targets.map((target) => `${target.object_id}\0${target.instance_id}`)).size ===
      targets.length,
    "targets must be unique",
  );
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

type OutputExtension = ".gcode" | ".gcode.3mf" | ".3mf" | ".scene.bin";

function outputPath(extension: OutputExtension) {
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

function artifactPath(extension: OutputExtension) {
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

const objectIds = z
  .array(opaqueId)
  .min(1)
  .max(256)
  .refine((ids) => uniqueBy(ids, String), "Object ids must be unique");
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
          "filename must be a root-level STL, OBJ, 3MF, STEP, or STP filename",
        ),
      bytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    })
    .strict(),
  project_create: z.object({}).strict(),
  project_restore: z.object({ path: z.string().startsWith("/workspace/").endsWith(".3mf"), expected_revision: revision }).strict(),
  scene_export: z.object({ ...projectWithRevision, output_path: outputPath(".scene.bin"), overwrite: z.boolean().default(false) }).strict(),
  model_import: z
    .object({
      ...projectWithRevision,
      path: z
        .string()
        .startsWith("/workspace/")
        .describe("Absolute model path beneath /workspace"),
      name: z
        .string()
        .min(1)
        .refine(
          (name) =>
            Buffer.byteLength(name, "utf8") <= 255 &&
            name !== "." &&
            name !== ".." &&
            !/[\u0000-\u001f\u007f/\\]/.test(name),
          "name must be a file name without directories",
        )
        .optional()
        .describe(
          "Original file name used to name the imported objects, e.g. the upload_prepare filename. Defaults to the path's file name.",
        ),
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
  object_auto_orient: z
    .object({ ...projectWithRevision, targets: instanceTargets.optional() })
    .strict(),
  object_delete: z
    .object({ ...projectWithRevision, targets: instanceTargets })
    .strict(),
  object_mirror: z
    .object({
      ...projectWithRevision,
      targets: instanceTargets,
      axis: z.enum(["x", "y", "z"]),
    })
    .strict(),
  object_filament_set: z
    .object({
      ...projectWithRevision,
      object_id: opaqueId,
      volume_id: opaqueId.optional(),
      filament: z.number().int().min(1).max(256),
    })
    .strict(),
  object_rename: z
    .object({
      ...projectWithRevision,
      object_id: opaqueId,
      name: z
        .string()
        .min(1)
        .refine(
          (name) => Buffer.byteLength(name, "utf8") <= 255 && !/[\u0000-\u001f\u007f]/.test(name),
          "name must be 1 to 255 bytes without control characters",
        ),
    })
    .strict(),
  scene_arrange: z
    .object({ ...projectWithRevision, plate_index: unsignedSafeInteger.optional() })
    .strict(),
  plate_add: z.object(projectWithRevision).strict(),
  plate_rename: z
    .object({
      ...projectWithRevision,
      plate_index: unsignedSafeInteger,
      // Orca's plate name editor limit.
      name: z.string().max(250),
    })
    .strict(),
  plate_delete: z
    .object({ ...projectWithRevision, plate_index: unsignedSafeInteger })
    .strict(),
  plate_lock: z
    .object({ ...projectWithRevision, plate_index: unsignedSafeInteger, locked: z.boolean() })
    .strict(),
  plate_move_to_front: z
    .object({ ...projectWithRevision, plate_index: unsignedSafeInteger })
    .strict(),
  printer_get: z.object(projectSnapshot).strict(),
  filaments_get: z.object(projectSnapshot).strict(),
  process_get: z.object(projectSnapshot).strict(),
  object_settings_get: z
    .object({ ...projectSnapshot, object_ids: objectIds.describe("Objects whose settings to read") })
    .strict(),
  object_settings_apply: z
    .object({
      ...projectWithRevision,
      object_ids: objectIds.describe("Objects that receive every change and reset"),
      changes: z
        .array(
          z
            .object({
              key: safeSettingKey.describe("Exact object-level setting key returned by object_settings_get"),
              value: settingValue.describe("Typed JSON value like settings_apply"),
            })
            .strict(),
        )
        .max(256)
        .refine((changes) => uniqueBy(changes, (change) => change.key), "Setting changes must be unique")
        .default([]),
      reset_keys: z
        .array(safeSettingKey)
        .max(256)
        .refine((keys) => uniqueBy(keys, String), "Reset keys must be unique")
        .default([])
        .describe("Remove these overrides so the objects follow the process again"),
    })
    .strict()
    .refine((request) => request.changes.length + request.reset_keys.length > 0, "Provide changes or reset_keys")
    .refine(
      (request) => !request.changes.some((change) => request.reset_keys.includes(change.key)),
      "A key cannot be both changed and reset",
    ),
  filament_color_set: z
    .object({
      ...projectWithRevision,
      index: unsignedSafeInteger,
      color: z.string().regex(/^#[0-9A-Fa-f]{6}$/, "color must be #RRGGBB"),
    })
    .strict(),
  filament_add: z.object(projectWithRevision).strict(),
  filament_delete: z
    .object({
      ...projectWithRevision,
      index: z.number().int().min(0).max(63).describe("Zero-based filament slot (filaments_get) to remove"),
    })
    .strict(),
  bed_type_set: z
    .object({ ...projectWithRevision, bed_type: z.string().min(1).max(64) })
    .strict(),
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
  job_cancel: z.object({ job_id: opaqueId }).strict(),
  gcode_export: z
    .object({
      ...projectWithRevision,
      slice_job_id: opaqueId,
      output_path: outputPath(".gcode"),
      overwrite: z.boolean().default(false),
    })
    .strict(),
  gcode_3mf_export: z
    .object({
      ...projectWithRevision,
      slice_job_id: opaqueId,
      output_path: outputPath(".gcode.3mf"),
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
  toolpath_render: z
    .object({
      ...projectWithRevision,
      slice_job_id: opaqueId,
      views: z
        .array(z.enum(["iso", "top", "front", "rear", "left", "right", "bottom", "top_front"]))
        .min(1)
        .max(6)
        .refine((views) => new Set(views).size === views.length, {
          message: "Toolpath render views must be unique",
        }),
      width: z.number().int().min(64).max(2048).default(1024),
      height: z.number().int().min(64).max(2048).default(1024),
      layer_range: z
        .object({
          start: unsignedSafeInteger,
          end: unsignedSafeInteger,
        })
        .strict()
        .refine((range) => range.start <= range.end, {
          message: "Layer range start must not exceed end",
        })
        .optional(),
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
  "scene_export",
  "model_import",
  "scene_get",
  "object_transform",
  "object_auto_orient",
  "object_delete",
  "object_mirror",
  "object_rename",
  "object_filament_set",
  "scene_arrange",
  "plate_add",
  "plate_rename",
  "plate_delete",
  "plate_lock",
  "plate_move_to_front",
  "printer_get",
  "bed_type_set",
  "filaments_get",
  "filament_color_set",
  "filament_add",
  "filament_delete",
  "process_get",
  "object_settings_get",
  "object_settings_apply",
  "scene_render",
  "toolpath_render",
  "desktop_capture",
  "presets_list",
  "presets_select",
  "settings_describe",
  "settings_get",
  "settings_apply",
  "slice_start",
  "job_get",
  "job_cancel",
  "gcode_export",
  "gcode_3mf_export",
  "project_save",
] as const;

type ToolName = (typeof toolNames)[number];
type BridgeToolName = Exclude<ToolName, "upload_prepare"> | "project_restore";

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
  scene_export: "Export a revision-bound native scene manifest and binary mesh buffers.",
  slicer_status: "Report native Orca bridge readiness, active project, revision, jobs, and capabilities.",
  upload_prepare:
    "Create a single-use authenticated HTTP upload ticket for a local STL, OBJ, 3MF, STEP, or STP file. PUT the raw bytes to the returned same-origin upload_path, then pass workspace_path to model_import with the same filename as name. Detailed guidance is available at agentslicer://docs/upload.",
  project_create: "Reset Orca to a new empty project and return its opaque project id and revision.",
  model_import:
    "Import an STL, OBJ, 3MF, STEP, or STP model already present beneath /workspace. For local client files, call upload_prepare and complete its HTTP PUT first; see agentslicer://docs/upload.",
  scene_get: "Inspect objects, instances, transforms, bounds, plates, and the current revision.",
  object_transform: "Move, rotate, scale, or place one model instance on the bed.",
  object_auto_orient:
    "Start Orca's native auto-orient operation for exact object/instance targets, or every printable unlocked instance when targets are omitted. Successful targets are placed on the bed.",
  object_delete:
    "Delete object instances like Orca's object list; deleting every instance of an object deletes the object. Objects that are part of a cut are refused.",
  object_mirror:
    "Mirror object instances along a world axis around each instance's own center and keep them on the bed, like Orca's Mirror menu.",
  object_rename: "Rename one object.",
  object_filament_set:
    "Assign a 1-based filament slot (filaments_get) to an object, or with volume_id to one of its model parts or modifiers, like Orca's object list. Setting the object clears its parts' own assignments.",
  scene_arrange:
    "Start Orca's native arrange operation for every plate, or only the zero-based plate_index like Orca's plate arrange icon. Locked plates are skipped.",
  plate_add: "Add an empty plate like Orca's Add Plate toolbar action and return its zero-based plate_index.",
  plate_rename: "Rename one zero-based plate. An empty name shows as Untitled in Orca.",
  plate_delete:
    "Remove one zero-based plate like Orca's plate icon. Its instances move off the plates; the last plate cannot be removed.",
  plate_lock: "Lock or unlock one zero-based plate. Arrange and auto-orient skip locked plates.",
  plate_move_to_front: "Move one zero-based plate to index 0 together with its instances, like Orca's plate icon.",
  printer_get:
    "Read Orca's sidebar printer section: the selected printer preset, model and nozzle variant, whether presets have unsaved edits, visible system printer models with their variant presets and cover image path, user printer presets, and the bed type with the types the printer supports (null when Orca hides the bed type).",
  filaments_get:
    "Read Orca's sidebar filament section: each zero-based filament slot's preset and #RRGGBB color, the visible filament presets with vendor, type, system/user origin and printer compatibility, and whether presets have unsaved edits. Change slot presets with presets_select filaments (one name per slot).",
  filament_color_set: "Set one zero-based filament slot's solid #RRGGBB color like Orca's color picker.",
  filament_add:
    "Add one filament slot like Orca's add filament button: it copies the last slot's preset, takes Orca's next palette color, and returns its zero-based index.",
  filament_delete:
    "Remove one zero-based filament slot like Orca's remove filament button (the last slot cannot be removed). Objects, parts and plates that used it move to Orca's default, and later slots shift down by one.",
  object_settings_get:
    "Read Orca's object settings tab in Simple mode for one or more object_ids (scene_get): Frequent, then the object-level options of the process pages. Values are the process value with each object's override; modified marks options some object overrides with a different value, mixed marks options whose value differs between the objects. Other fields match process_get.",
  object_settings_apply:
    "Set per-object setting overrides on every given object, like Orca's Objects mode, and remove reset_keys overrides so the objects follow the process again. Values are typed like settings_apply. An override equal to the process value is removed. Overrides are saved in the project and used when slicing.",
  process_get:
    "Read Orca's sidebar Process tab in Simple mode: the selected process preset (and whether it has unsaved edits), compatible process presets, and pages of option groups in Orca's order. Each option has its label, type, control, unit, limits, choices with labels and icon paths, effective and saved values, and Orca's modified and enabled state. Change values with settings_apply in process scope; icon paths are served like printer_get images.",
  bed_type_set:
    "Set the project bed type (a printer_get bed type key such as \"Textured PEI Plate\") like Orca's bed type selector.",
  scene_render:
    "Render one to six clean PNG views of the active scene as inline MCP image content. Returned paths are internal identifiers, not HTTP URLs.",
  toolpath_render:
    "Render one to six PNG views of a completed slice using Orca line-type colors. Includes the enabled extrusion features and seam markers; excludes travel, wipe, retract, unretract, tool/filament changes, pauses, and custom G-code motions. Returns the exact color legend and rendered zero-based layer range.",
  desktop_capture:
    "Capture the complete Orca desktop as inline MCP image content for diagnostics, including modal dialogs. The returned path is not an HTTP URL.",
  presets_list:
    "List exact printer, process, and filament preset names and Orca's compatibility/selection state. Scopes are printer hardware, print process, and filament.",
  presets_select:
    "Atomically select exact preset names. Printer and process are single presets; filaments list one preset per filament slot (filaments_get). Selecting only a printer keeps compatible process and filament presets and replaces incompatible ones like Orca's printer selector. Exact already-selected names are revision-neutral. discard_dirty must be explicit before unsaved edits are discarded.",
  settings_describe:
    "Discover paginated Orca settings by key, label, description, or scope. Each result declares its native value type, scope, editability, unit text, numeric limits, and enum values; never infer units or values.",
  settings_get:
    "Read typed effective values for exact setting keys and scopes. Use filament_index for a selected extruder slot. Float-or-percent values are {value, percent}; points and point groups are nested numeric arrays.",
  settings_apply:
    "Validate and atomically apply typed JSON setting changes in printer, process, or filament scope (using filament_index for an extruder slot). Float-or-percent values are {value, percent}; points and point groups are nested numeric arrays. dry_run validates the entire batch without mutation.",
  slice_start:
    "Start slicing one zero-based plate and return immediately with a running job. A successful job includes print time, filament, cost, change, travel, per-extruder, and per-feature metrics with explicit units, plus Orca's preview line-type legend: per line type time, filament length and weight with Orca's colors, travel/wipe/retract/unretract/seam/filament-change time, distance and count, and model filament.",
  job_get: "Get the current state, progress, result, and error for an asynchronous job.",
  job_cancel:
    "Cancel a running asynchronous job. Cancellation is idempotent: terminal jobs are returned unchanged, while accepted cancellation returns the stable cancelled job snapshot.",
  gcode_export:
    "Export a successful slice job to a root-level .gcode filename beneath /outputs. Download the successful result path from the MCP origin with the same bearer token.",
  gcode_3mf_export:
    "Export a successful slice job to a root-level .gcode.3mf Bambu print archive beneath /outputs. Download the successful result path from the MCP origin with the same bearer token.",
  project_save:
    "Save the active project to a root-level .3mf filename beneath /outputs. Download the successful result path from the MCP origin with the same bearer token.",
};

const projectResultSchema = z.object({ project_id: opaqueId, revision }).strict();
const printerResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    selected: z
      .object({ preset: z.string(), model: z.string(), variant: z.string(), system: z.boolean() })
      .strict(),
    dirty: z.boolean(),
    models: z.array(
      z
        .object({
          model: z.string(),
          vendor: z.string(),
          cover: z.string().nullable(),
          variants: z.array(z.object({ variant: z.string(), preset: z.string() }).strict()),
        })
        .strict(),
    ),
    user_presets: z.array(
      z.object({ preset: z.string(), model: z.string(), variant: z.string() }).strict(),
    ),
    bed: z
      .object({
        type: z.string().nullable(),
        types: z.array(
          z.object({ key: z.string(), label: z.string(), image: z.string().nullable() }).strict(),
        ),
      })
      .strict()
      .nullable(),
  })
  .strict();
const filamentsResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    slots: z.array(
      z
        .object({ index: unsignedSafeInteger, preset: z.string(), label: z.string(), color: z.string() })
        .strict(),
    ),
    presets: z.array(
      z
        .object({
          name: z.string(),
          label: z.string(),
          vendor: z.string(),
          type: z.string(),
          system: z.boolean(),
          compatible: z.boolean(),
        })
        .strict(),
    ),
    dirty: z.boolean(),
  })
  .strict();
const settingsOptionFields = {
  key: z.string(),
  label: z.string(),
  tooltip: z.string(),
  type: z.string(),
  control: z.enum(["checkbox", "filament", "select", "spin", "text"]),
  unit: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  choices: z
    .array(z.object({ value: z.string(), label: z.string(), icon: z.string().nullable() }).strict())
    .nullable(),
  value: settingValue,
  modified: z.boolean(),
  enabled: z.boolean(),
};
const settingsPagesSchema = <T extends z.ZodTypeAny>(option: T) =>
  z.array(
    z
      .object({
        title: z.string(),
        modified: z.boolean(),
        groups: z.array(
          z.object({ title: z.string(), icon: z.string().nullable(), options: z.array(option) }).strict(),
        ),
      })
      .strict(),
  );
const processOptionSchema = z.object({ ...settingsOptionFields, saved_value: settingValue }).strict();
const objectOptionSchema = z.object({ ...settingsOptionFields, mixed: z.boolean() }).strict();
const objectSettingsResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    object_ids: z.array(opaqueId),
    pages: settingsPagesSchema(objectOptionSchema),
  })
  .strict();
const processResultSchema = z
  .object({
    project_id: opaqueId,
    revision,
    preset: z.object({ name: z.string(), system: z.boolean(), modified: z.boolean() }).strict(),
    presets: z.array(z.object({ name: z.string(), system: z.boolean() }).strict()),
    pages: settingsPagesSchema(processOptionSchema),
    dirty: z.boolean(),
  })
  .strict();
const filamentAddResultSchema = projectResultSchema.extend({ index: unsignedSafeInteger }).strict();
const bedTypeResultSchema = projectResultSchema
  .extend({ bed_type: z.string() })
  .strict();
const plateResultSchema = projectResultSchema
  .extend({ plate_index: unsignedSafeInteger })
  .strict();
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
        // 1-based filament slot; absent from images without object_filament_set.
        filament: z.number().int().positive().optional(),
        bounds: boundsSchema,
        instances: z.array(
          z.object({
            instance_id: opaqueId,
            instance_index: z.number().int().nonnegative(),
            offset_mm: z.array(z.number().finite()).length(3),
            rotation_deg: z.array(z.number().finite()).length(3),
            scale: z.array(z.number().positive().finite()).length(3),
            // Canonical form R * S * Mx; absent from images without it.
            mirrored: z.boolean().optional(),
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
        // Absent from native images that do not advertise plate_lock.
        locked: z.boolean().optional(),
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
const autoOrientJobSchema = z
  .object({
    ...jobBase,
    type: z.literal("auto_orient"),
    metadata: z
      .object({
        config_snapshot: configSnapshotSchema,
      })
      .strict(),
    result: z
      .object({
        oriented: z.literal(true),
      })
      .strict()
      .nullable(),
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
const hexColor = z.string().regex(/^#[0-9A-F]{6}$/);
const printMetricsSchema = z
  .object({
    time: z
      .object({
        normal_seconds: z.number().nonnegative(),
        silent_seconds: z.number().nonnegative().nullable(),
        preparation_seconds: z.number().nonnegative(),
      })
      .strict(),
    filament: z
      .object({
        used_length_mm: z.number().nonnegative(),
        extruded_volume_mm3: z.number().nonnegative(),
        weight_g: z.number().nonnegative(),
        total_cost: z.number().nonnegative(),
        wipe_tower_used_length_mm: z.number().nonnegative(),
        wipe_tower_cost: z.number().nonnegative(),
        per_extruder: z
          .array(
            z
              .object({
                extruder_id: unsignedSafeInteger,
                model_volume_mm3: z.number().nonnegative(),
                support_volume_mm3: z.number().nonnegative(),
                wipe_tower_volume_mm3: z.number().nonnegative(),
                flushed_volume_mm3: z.number().nonnegative(),
                total_volume_mm3: z.number().nonnegative(),
              })
              .strict(),
          )
          .max(64),
        per_feature: z
          .array(
            z
              .object({
                feature: z.string().min(1).max(64),
                used_length_mm: z.number().nonnegative(),
                weight_g: z.number().nonnegative(),
              })
              .strict(),
          )
          .max(64),
      })
      .strict(),
    changes: z
      .object({
        tool_changes: unsignedSafeInteger,
        filament_changes: unsignedSafeInteger,
        extruder_changes: unsignedSafeInteger,
      })
      .strict(),
    travel: z
      .object({
        distance_mm: z.number().nonnegative(),
        move_count: unsignedSafeInteger,
      })
      .strict(),
    initial_tool: unsignedSafeInteger,
    line_types: z
      .object({
        roles: z
          .array(
            z
              .object({
                key: z.string(),
                label: z.string(),
                color: hexColor,
                time_seconds: z.number().nonnegative(),
                length_mm: z.number().nonnegative(),
                weight_g: z.number().nonnegative(),
              })
              .strict(),
          )
          .max(32),
        options: z
          .array(
            z
              .object({
                key: z.enum(["travel", "wipe", "retract", "unretract", "seams", "filament_changes"]),
                label: z.string(),
                color: hexColor,
                time_seconds: z.number().nonnegative(),
                distance_mm: z.number().nonnegative().nullable(),
                count: unsignedSafeInteger,
              })
              .strict(),
          )
          .max(8),
        model_filament: z
          .object({ length_mm: z.number().nonnegative(), weight_g: z.number().nonnegative() })
          .strict(),
      })
      .strict(),
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
        print_metrics: printMetricsSchema,
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
const gcode3mfExportJobSchema = z
  .object({
    ...jobBase,
    type: z.literal("gcode_3mf_export"),
    metadata: z
      .object({
        slice_job_id: opaqueId,
        output_path: outputPath(".gcode.3mf"),
        config_snapshot: configSnapshotSchema,
      })
      .strict(),
    result: z
      .object({
        path: artifactPath(".gcode.3mf"),
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
const sceneExportJobSchema = z.object({ ...jobBase, type: z.literal("scene_export"),
  metadata: z.object({ output_path: outputPath(".scene.bin") }).strict(),
  result: z.object({ path: artifactPath(".scene.bin"), bytes: z.number().int().nonnegative() }).strict().nullable(),
}).strict();
export const jobResultSchema = z.discriminatedUnion("type", [
  arrangeJobSchema,
  autoOrientJobSchema,
  modelImportJobSchema,
  sliceJobSchema,
  gcodeExportJobSchema,
  gcode3mfExportJobSchema,
  projectSaveJobSchema,
  sceneExportJobSchema,
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
  if ((method === "scene_render" || method === "toolpath_render") &&
      Array.isArray(params.views)) {
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
    logApiFailure(`command.${method}`, error);
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

const layerRangeSchema = z.object({
  start: unsignedSafeInteger,
  end: unsignedSafeInteger,
}).strict();

const toolpathLegendItemSchema = z.object({
  feature: z.string().min(1).max(64),
  label: z.string().min(1).max(64),
  color: z.string().regex(/^#[0-9A-F]{6}$/),
  kind: z.enum(["extrusion", "marker"]),
}).strict();

const excludedToolpathMoveSchema = z.enum([
  "travel",
  "wipe",
  "retract",
  "unretract",
  "tool_change",
  "filament_change",
  "pause",
  "custom_gcode",
]);

const nativeToolpathRenderResultSchema = z.object({
  project_id: opaqueId,
  revision,
  slice_job_id: opaqueId,
  plate_index: unsignedSafeInteger,
  available_layer_range: layerRangeSchema,
  rendered_layer_range: layerRangeSchema,
  legend: z.array(toolpathLegendItemSchema).length(13).refine(
    (items) => new Set(items.map((item) => item.feature)).size === items.length,
    "Toolpath legend features must be unique",
  ),
  excluded_move_types: z.array(excludedToolpathMoveSchema).length(8).refine(
    (items) => new Set(items).size === items.length,
    "Excluded toolpath move types must be unique",
  ),
  images: z.array(z.object({
    path: z.string(),
    view: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    mime_type: z.literal("image/png"),
    bytes: z.number().int().positive(),
    segment_count: unsignedSafeInteger,
    seam_count: unsignedSafeInteger,
  }).strict()).min(1).max(6),
}).strict();

const mcpToolpathRenderResultSchema = nativeToolpathRenderResultSchema
  .omit({ images: true })
  .extend({
    images: z.array(z.object({
      path: z.string(),
      view: z.enum(["iso", "top", "front", "rear", "left", "right", "bottom", "top_front"]),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      mime_type: z.literal("image/png"),
      bytes: z.number().int().positive(),
      segment_count: unsignedSafeInteger,
      seam_count: unsignedSafeInteger,
    }).strict()).min(1).max(6),
  })
  .strict();

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

type NativeRenderImage = {
  path: string;
  view: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
};

async function readRenderedPngs(
  dependencies: ToolDependencies,
  nativeParams: Record<string, unknown>,
  nativeImages: readonly NativeRenderImage[],
) {
  const capturedIdentities = new Map<
    string,
    Awaited<ReturnType<typeof readInternalPng>>["fileIdentity"]
  >();
  try {
    const readPng = dependencies.readPng ?? readInternalPng;
    const requestedWidth = nativeParams.width as number;
    const requestedHeight = nativeParams.height as number;
    const requestedViews = nativeParams.views as string[];
    if (nativeImages.length !== requestedViews.length) {
      throw new Error("Native render returned a different image count than requested");
    }
    if (new Set(nativeImages.map((image) => image.view)).size !== nativeImages.length) {
      throw new Error("Native render returned duplicate views");
    }
    const settledImages = await Promise.allSettled(
      nativeImages.map(async (image, index) => {
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
    return settledImages.map((result) => {
      if (result.status !== "fulfilled") {
        throw new Error("Rendered PNG validation did not settle");
      }
      return result.value;
    });
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
}

function inlineRenderResult(
  structuredContent: Record<string, unknown>,
  images: Awaited<ReturnType<typeof readRenderedPngs>>,
): CallToolResult {
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
}

async function sceneRender(
  dependencies: ToolDependencies,
  params: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const nativeParams = toBridgeParams("scene_render", params);
    const bridgeResult = renderResultSchema.parse(
      await dependencies.bridge.call("scene_render", nativeParams),
    );
    const images = await readRenderedPngs(dependencies, nativeParams, bridgeResult.images);
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
    return inlineRenderResult(structuredContent, images);
  } catch (error) {
    return toolErrorResult(error);
  }
}

async function toolpathRender(
  dependencies: ToolDependencies,
  params: Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    const nativeParams = toBridgeParams("toolpath_render", params);
    const bridgeResult = nativeToolpathRenderResultSchema.parse(
      await dependencies.bridge.call("toolpath_render", nativeParams),
    );
    const images = await readRenderedPngs(dependencies, nativeParams, bridgeResult.images);
    const structuredContent = mcpToolpathRenderResultSchema.parse({
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
    return inlineRenderResult(structuredContent, images);
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

// Both transports execute these operations, including upload and render handling.
function defineCommand<Input extends z.ZodType>(
  inputSchema: Input,
  outputSchema: z.ZodType,
  execute: (params: z.output<Input>) => Promise<CallToolResult>,
) {
  return { inputSchema, outputSchema, execute: (params: unknown) => execute(inputSchema.parse(params)) };
}

export function createAgentCommands(dependencies: AgentToolDependencies) {
  return {
    slicer_status: defineCommand(toolSchemas.slicer_status, statusResultSchema, () => bridgeTool(dependencies, "slicer_status", {}, statusResultSchema)),
    upload_prepare: defineCommand(toolSchemas.upload_prepare, uploadPreparationResultSchema, async (params) => {
      try {
        const prepared = await dependencies.uploads.prepare(params);
        return successResult(uploadPreparationResultSchema.parse(prepared));
      } catch (error) {
        return toolErrorResult(error);
      }
    }),
    project_create: defineCommand(toolSchemas.project_create, projectResultSchema, () => bridgeTool(dependencies, "project_create", {}, projectResultSchema)),
    project_restore: defineCommand(toolSchemas.project_restore, projectResultSchema, (params) => bridgeTool(dependencies, "project_restore", params, projectResultSchema)),
    scene_export: defineCommand(toolSchemas.scene_export, runningJobStartResultSchema, (params) => bridgeTool(dependencies, "scene_export", params, runningJobStartResultSchema)),
    model_import: defineCommand(toolSchemas.model_import, registeredJobStartResultSchema, (params) => bridgeTool(dependencies, "model_import", params, registeredJobStartResultSchema)),
    scene_get: defineCommand(toolSchemas.scene_get, sceneResultSchema, (params) => bridgeTool(dependencies, "scene_get", params, sceneResultSchema)),
    object_transform: defineCommand(toolSchemas.object_transform, projectResultSchema, (params) => bridgeTool(dependencies, "object_transform", params, projectResultSchema)),
    object_auto_orient: defineCommand(toolSchemas.object_auto_orient, runningJobStartResultSchema, (params) => bridgeTool(
      dependencies,
      "object_auto_orient",
      params,
      runningJobStartResultSchema,
    )),
    object_delete: defineCommand(toolSchemas.object_delete, projectResultSchema, (params) => bridgeTool(dependencies, "object_delete", params, projectResultSchema)),
    object_mirror: defineCommand(toolSchemas.object_mirror, projectResultSchema, (params) => bridgeTool(dependencies, "object_mirror", params, projectResultSchema)),
    object_filament_set: defineCommand(toolSchemas.object_filament_set, projectResultSchema, (params) => bridgeTool(dependencies, "object_filament_set", params, projectResultSchema)),
    object_rename: defineCommand(toolSchemas.object_rename, projectResultSchema, (params) => bridgeTool(dependencies, "object_rename", params, projectResultSchema)),
    scene_arrange: defineCommand(toolSchemas.scene_arrange, runningJobStartResultSchema, (params) => bridgeTool(dependencies, "scene_arrange", params, runningJobStartResultSchema)),
    plate_add: defineCommand(toolSchemas.plate_add, plateResultSchema, (params) => bridgeTool(dependencies, "plate_add", params, plateResultSchema)),
    plate_rename: defineCommand(toolSchemas.plate_rename, plateResultSchema, (params) => bridgeTool(dependencies, "plate_rename", params, plateResultSchema)),
    plate_delete: defineCommand(toolSchemas.plate_delete, plateResultSchema, (params) => bridgeTool(dependencies, "plate_delete", params, plateResultSchema)),
    plate_lock: defineCommand(toolSchemas.plate_lock, plateResultSchema, (params) => bridgeTool(dependencies, "plate_lock", params, plateResultSchema)),
    printer_get: defineCommand(toolSchemas.printer_get, printerResultSchema, (params) => bridgeTool(dependencies, "printer_get", params, printerResultSchema)),
    filaments_get: defineCommand(toolSchemas.filaments_get, filamentsResultSchema, (params) => bridgeTool(dependencies, "filaments_get", params, filamentsResultSchema)),
    process_get: defineCommand(toolSchemas.process_get, processResultSchema, (params) => bridgeTool(dependencies, "process_get", params, processResultSchema)),
    object_settings_get: defineCommand(toolSchemas.object_settings_get, objectSettingsResultSchema, (params) => bridgeTool(dependencies, "object_settings_get", params, objectSettingsResultSchema)),
    object_settings_apply: defineCommand(toolSchemas.object_settings_apply, projectResultSchema, (params) => bridgeTool(dependencies, "object_settings_apply", params, projectResultSchema)),
    filament_color_set: defineCommand(toolSchemas.filament_color_set, projectResultSchema, (params) => bridgeTool(dependencies, "filament_color_set", params, projectResultSchema)),
    filament_add: defineCommand(toolSchemas.filament_add, filamentAddResultSchema, (params) => bridgeTool(dependencies, "filament_add", params, filamentAddResultSchema)),
    filament_delete: defineCommand(toolSchemas.filament_delete, projectResultSchema, (params) => bridgeTool(dependencies, "filament_delete", params, projectResultSchema)),
    bed_type_set: defineCommand(toolSchemas.bed_type_set, bedTypeResultSchema, (params) => bridgeTool(dependencies, "bed_type_set", params, bedTypeResultSchema)),
    plate_move_to_front: defineCommand(toolSchemas.plate_move_to_front, plateResultSchema, (params) => bridgeTool(dependencies, "plate_move_to_front", params, plateResultSchema)),
    scene_render: defineCommand(toolSchemas.scene_render, mcpRenderResultSchema, (params) => sceneRender(dependencies, params)),
    toolpath_render: defineCommand(toolSchemas.toolpath_render, mcpToolpathRenderResultSchema, (params) => toolpathRender(dependencies, params)),
    desktop_capture: defineCommand(toolSchemas.desktop_capture, desktopResultSchema, (params) => desktopCapture(dependencies, params)),
    presets_list: defineCommand(toolSchemas.presets_list, presetsListResultSchema, (params) => bridgeTool(dependencies, "presets_list", params, presetsListResultSchema)),
    presets_select: defineCommand(toolSchemas.presets_select, presetsSelectResultSchema, (params) => bridgeTool(dependencies, "presets_select", params, presetsSelectResultSchema)),
    settings_describe: defineCommand(toolSchemas.settings_describe, settingsDescribeResultSchema, (params) =>
      bridgeTool(dependencies, "settings_describe", params, settingsDescribeResultSchema)),
    settings_get: defineCommand(toolSchemas.settings_get, settingsGetResultSchema, (params) => bridgeTool(dependencies, "settings_get", params, settingsGetResultSchema)),
    settings_apply: defineCommand(toolSchemas.settings_apply, settingsApplyResultSchema, (params) => bridgeTool(dependencies, "settings_apply", params, settingsApplyResultSchema)),
    slice_start: defineCommand(toolSchemas.slice_start, runningJobStartResultSchema, (params) => bridgeTool(dependencies, "slice_start", params, runningJobStartResultSchema)),
    job_get: defineCommand(toolSchemas.job_get, jobResultSchema, (params) => bridgeTool(dependencies, "job_get", params, jobResultSchema)),
    job_cancel: defineCommand(toolSchemas.job_cancel, jobResultSchema, (params) => bridgeTool(dependencies, "job_cancel", params, jobResultSchema)),
    gcode_export: defineCommand(toolSchemas.gcode_export, runningJobStartResultSchema, (params) => bridgeTool(dependencies, "gcode_export", params, runningJobStartResultSchema)),
    gcode_3mf_export: defineCommand(toolSchemas.gcode_3mf_export, runningJobStartResultSchema, (params) => bridgeTool(
      dependencies,
      "gcode_3mf_export",
      params,
      runningJobStartResultSchema,
    )),
    project_save: defineCommand(toolSchemas.project_save, registeredJobStartResultSchema, (params) => bridgeTool(dependencies, "project_save", params, registeredJobStartResultSchema)),
  };
}

export function createPublicAgentCommands(dependencies: AgentToolDependencies) {
  const commands = createAgentCommands(dependencies);
  // Full configuration restore belongs to the verified checkpoint service.
  return Object.fromEntries(toolNames.map((name) => [name, commands[name]])) as Pick<typeof commands, ToolName>;
}

export function registerAgentTools(server: McpServer, dependencies: AgentToolDependencies): void {
  for (const [name, command] of Object.entries(createPublicAgentCommands(dependencies))) {
    server.registerTool(name, {
      description: descriptions[name as ToolName],
      inputSchema: command.inputSchema,
      outputSchema: command.outputSchema,
    }, (params: unknown) => command.execute(params));
  }
}
