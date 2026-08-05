import { describe, expect, it } from "vitest";

import {
  jobResultSchema,
  toBridgeParams,
  toolNames,
  toolSchemas,
} from "../src/tool-contract.js";

describe("MCP tool schemas", () => {
  it("exports the deterministic tool order", () => {
    expect(toolNames).toEqual([
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
    ]);
  });

  it("accepts only root-level supported upload filenames and strong checksums", () => {
    expect(toolSchemas.upload_prepare.safeParse({
      filename: "part.STL",
      bytes: 123,
      sha256: "a".repeat(64),
    }).success).toBe(true);
    for (const filename of ["part.step", "part.STP"]) {
      expect(toolSchemas.upload_prepare.safeParse({
        filename,
        bytes: 123,
        sha256: "a".repeat(64),
      }).success, filename).toBe(true);
    }
    for (const filename of ["../part.stl", "nested/part.obj", "part.gcode", ".stl"]) {
      expect(toolSchemas.upload_prepare.safeParse({
        filename,
        bytes: 123,
        sha256: "a".repeat(64),
      }).success, filename).toBe(false);
    }
    expect(toolSchemas.upload_prepare.safeParse({
      filename: "part.3mf",
      bytes: 0,
      sha256: "a".repeat(64),
    }).success).toBe(false);
    expect(toolSchemas.upload_prepare.safeParse({
      filename: "part.3mf",
      bytes: 123,
      sha256: "not-a-sha256",
    }).success).toBe(false);
  });

  it("requires project ids and revisions on mutations", () => {
    expect(
      toolSchemas.model_import.safeParse({
        project_id: "project-1",
        expected_revision: 4,
        path: "/workspace/cube.stl",
      }).success,
    ).toBe(true);
    expect(
      toolSchemas.model_import.safeParse({
        project_id: "project-1",
        path: "/workspace/cube.stl",
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.object_auto_orient.safeParse({
        project_id: "project-1",
        expected_revision: 4,
        targets: [{ object_id: "object-1", instance_id: "instance-1" }],
      }).success,
    ).toBe(true);
    expect(
      toolSchemas.object_auto_orient.safeParse({
        project_id: "project-1",
        targets: [{ object_id: "object-1", instance_id: "instance-1" }],
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.scene_arrange.safeParse({
        project_id: "project-1",
        expected_revision: -1,
      }).success,
    ).toBe(false);
  });

  it("accepts all-instance auto-orient and rejects duplicate exact targets", () => {
    expect(toolSchemas.object_auto_orient.safeParse({
      project_id: "project-1",
      expected_revision: 2,
    }).success).toBe(true);
    const target = { object_id: "object-1", instance_id: "instance-1" };
    expect(toolSchemas.object_auto_orient.safeParse({
      project_id: "project-1",
      expected_revision: 2,
      targets: [target, target],
    }).success).toBe(false);
  });

  it("rejects unknown fields, invalid paths, and no-op transforms", () => {
    expect(
      toolSchemas.scene_get.safeParse({ project_id: "project-1", unexpected: true }).success,
    ).toBe(false);
    expect(
      toolSchemas.model_import.safeParse({
        project_id: "project-1",
        expected_revision: 1,
        path: "/etc/passwd",
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.object_transform.safeParse({
        project_id: "project-1",
        expected_revision: 1,
        object_id: "object-1",
        instance_id: "instance-1",
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.object_transform.safeParse({
        project_id: "project-1",
        expected_revision: 1,
        object_id: "object-1",
        instance_id: "instance-1",
        place_on_bed: false,
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.object_transform.safeParse({
        project_id: "project-1",
        expected_revision: 1,
        object_id: "object-1",
        instance_id: "instance-1",
        place_on_bed: true,
      }).success,
    ).toBe(true);
    expect(
      toolSchemas.object_transform.safeParse({
        project_id: "project-1",
        expected_revision: 1,
        object_id: "object-1",
        instance_id: "instance-1",
        position_mm: { x: 1, y: 2, z: 3 },
        place_on_bed: false,
      }).success,
    ).toBe(true);
  });

  it("bounds render view count and dimensions", () => {
    expect(
      toolSchemas.scene_render.safeParse({
        project_id: "project-1",
        views: ["iso", "front", "top"],
        width: 1024,
        height: 768,
      }).success,
    ).toBe(true);
    expect(
      toolSchemas.scene_render.safeParse({
        project_id: "project-1",
        views: ["iso"],
        width: 32,
        height: 768,
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.scene_render.safeParse({
        project_id: "project-1",
        views: ["iso", "iso"],
      }).success,
    ).toBe(false);
  });

  it("has a strict job_get schema and does not expose unsupported render fit", () => {
    expect(toolSchemas.job_get.safeParse({ job_id: "job-1" }).success).toBe(true);
    expect(toolSchemas.job_get.safeParse({ job_id: "job-1", extra: true }).success).toBe(false);
    expect(
      toolSchemas.scene_render.safeParse({
        project_id: "project-1",
        views: ["iso"],
        fit: false,
      }).success,
    ).toBe(false);
  });

  it("validates slicing and bounded root-level output filenames with exact extensions", () => {
    expect(
      toolSchemas.slice_start.safeParse({
        project_id: "project-1",
        expected_revision: 4,
        plate_index: Number.MAX_SAFE_INTEGER,
      }).success,
    ).toBe(true);
    expect(
      toolSchemas.slice_start.safeParse({
        project_id: "project-1",
        expected_revision: 4,
        plate_index: -1,
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.slice_start.safeParse({
        project_id: "project-1",
        expected_revision: 4,
        plate_index: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.gcode_export.parse({
        project_id: "project-1",
        expected_revision: 4,
        slice_job_id: "slice-1",
        output_path: "part.gcode",
      }).overwrite,
    ).toBe(false);
    expect(
      toolSchemas.project_save.parse({
        project_id: "project-1",
        expected_revision: 4,
        output_path: "part.3mf",
      }).overwrite,
    ).toBe(false);

    for (const output_path of [
      "",
      "/absolute/part.gcode",
      "./part.gcode",
      "nested/part.gcode",
      "nested/../part.gcode",
      "nested\\part.gcode",
      "part.GCODE",
      "part.gcode\0ignored",
      `${"a".repeat(1020)}.gcode`,
    ]) {
      expect(
        toolSchemas.gcode_export.safeParse({
          project_id: "project-1",
          expected_revision: 4,
          slice_job_id: "slice-1",
          output_path,
        }).success,
        output_path,
      ).toBe(false);
    }
    expect(
      toolSchemas.project_save.safeParse({
        project_id: "project-1",
        expected_revision: 4,
        output_path: "part.gcode",
      }).success,
    ).toBe(false);
  });

  it("centralizes the MCP-to-native transform and view representation", () => {
    expect(
      toBridgeParams("object_transform", {
        project_id: "project-1",
        position_mm: { x: 1, y: 2, z: 3 },
        rotation_deg: { x: 0, y: 0, z: 90 },
        scale: 2,
      }),
    ).toEqual({
      project_id: "project-1",
      offset_mm: [1, 2, 3],
      rotation_deg: [0, 0, 90],
      scale: [2, 2, 2],
    });
    expect(toBridgeParams("scene_render", { views: ["iso", "top_front"] })).toEqual({
      views: ["iso", "topfront"],
    });
    const settings = {
      project_id: "project-1",
      expected_revision: 3,
      changes: [{ key: "layer_height", scope: "process", value: 0.2 }],
      dry_run: true,
    };
    expect(toBridgeParams("settings_apply", settings)).toBe(settings);
  });

  it("validates preset selection and discovery filters without guessing preset names", () => {
    expect(
      toolSchemas.presets_select.safeParse({
        project_id: "project-1",
        expected_revision: 3,
        selection: {
          printer: "Custom CoreXY",
          process: "0.20mm Quality",
          filaments: ["Generic PLA", "Generic PETG"],
        },
        discard_dirty: true,
      }).success,
    ).toBe(true);
    expect(
      toolSchemas.presets_select.safeParse({
        project_id: "project-1",
        expected_revision: 3,
        selection: {},
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.settings_describe.safeParse({
        project_id: "project-1",
        expected_revision: 3,
        query: "layer",
        scopes: ["process"],
        cursor: "next-100",
        limit: 50,
      }).success,
    ).toBe(true);
  });

  it("requires unique scoped setting keys and typed JSON changes", () => {
    const valid = {
      project_id: "project-1",
      expected_revision: 3,
      changes: [
        { key: "layer_height", scope: "process", value: 0.2 },
        { key: "compatible_printers", scope: "process", value: ["CoreXY"] },
        { key: "bed_shape", scope: "printer", value: [[0, 0], [250, 250]] },
        { key: "nullable_setting", scope: "filament", value: null },
      ],
      dry_run: true,
    };
    expect(toolSchemas.settings_apply.safeParse(valid).success).toBe(true);
    expect(
      toolSchemas.settings_apply.safeParse({
        ...valid,
        changes: [{ key: "machine_start_gcode", scope: "printer", value: "G28" }],
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.settings_apply.safeParse({
        ...valid,
        changes: [{ key: "gcode_flavor", scope: "printer", value: "Marlin" }],
      }).success,
    ).toBe(true);
    expect(
      toolSchemas.settings_apply.safeParse({
        ...valid,
        changes: [
          { key: "layer_height", scope: "process", value: 0.2 },
          { key: "layer_height", scope: "process", value: 0.3 },
        ],
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.settings_apply.safeParse({
        ...valid,
        changes: [{ key: "layer_height", scope: "project", value: 0.2 }],
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.settings_apply.safeParse({
        ...valid,
        changes: [{ key: "layer_height", scope: "process", value: { millimeters: 0.2 } }],
      }).success,
    ).toBe(false);
  });

  it("supports round-trippable nested and per-filament typed settings", () => {
    const base = {
      project_id: "project-1",
      expected_revision: 3,
      dry_run: true,
    };
    expect(
      toolSchemas.settings_apply.safeParse({
        ...base,
        changes: [
          {
            key: "extruder_printable_area",
            scope: "printer",
            value: [
              [[0, 0], [100, 0], [100, 100]],
              [[10, 10], [90, 10], [90, 90]],
            ],
          },
          {
            key: "line_width",
            scope: "filament",
            filament_index: 0,
            value: { value: 110, percent: true },
          },
          {
            key: "line_width",
            scope: "filament",
            filament_index: 1,
            value: { value: 0.45, percent: false },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      toolSchemas.settings_apply.safeParse({
        ...base,
        changes: [
          { key: "temperature", scope: "filament", value: 210 },
          { key: "temperature", scope: "filament", filament_index: 0, value: 220 },
        ],
      }).success,
    ).toBe(false);
    expect(
      toolSchemas.settings_get.safeParse({
        project_id: "project-1",
        settings: [{ key: "layer_height", scope: "process", filament_index: 1 }],
      }).success,
    ).toBe(false);
  });

  it("accepts strict v2 override provenance and rejects unsafe visible fields", () => {
    const snapshot = {
      schema_version: 2,
      revision: 4,
      presets: {
        printer: "CoreXY",
        process: "0.20mm Quality",
        filaments: ["Generic PLA"],
      },
      settings: { layer_height: "0.2" },
      overrides: [
        {
          kind: "object",
          identity: "object_10",
          settings: { wall_loops: "3" },
          effective_sha256: "a".repeat(64),
        },
        {
          kind: "volume",
          identity: "object_10/volume_12",
          settings: {},
          effective_sha256: "a".repeat(64),
        },
        {
          kind: "plate",
          identity: "plate_0",
          settings: { curr_bed_type: "1" },
          effective_sha256: "b".repeat(64),
        },
      ],
      redacted_keys: [
        "global/post_process",
        "object_10/private_plugin_setting",
        "object_10/volume_12/printhost_password",
        "plate_0/host_token",
      ],
      sha256: "c".repeat(64),
      bytes: 4096,
    };
    const job = {
      job_id: "slice-1",
      type: "slice",
      state: "running",
      progress: 0.5,
      project_id: "project-1",
      source_revision: 4,
      warnings: [],
      metadata: { plate_index: 0, config_snapshot: snapshot },
      result: null,
      error: null,
      revision: 4,
    };

    expect(jobResultSchema.safeParse(job).success).toBe(true);
    expect(jobResultSchema.safeParse({
      ...job,
      metadata: {
        ...job.metadata,
        config_snapshot: {
          ...snapshot,
          overrides: [{
            ...snapshot.overrides[0],
            settings: { printhost_password: "must-not-leak" },
            path: "/tmp/must-not-leak",
          }],
        },
      },
    }).success).toBe(false);
    expect(jobResultSchema.safeParse({
      ...job,
      metadata: {
        ...job.metadata,
        config_snapshot: {
          ...snapshot,
          overrides: [...snapshot.overrides].reverse(),
        },
      },
    }).success).toBe(false);
    expect(jobResultSchema.safeParse({
      ...job,
      metadata: {
        ...job.metadata,
        config_snapshot: {
          ...snapshot,
          redacted_keys: ["post_process"],
        },
      },
    }).success).toBe(false);

    const manySettings = Object.fromEntries(
      Array.from({ length: 4097 }, (_, index) => [`setting_${index}`, ""]),
    );
    const manyRedactedKeys = Array.from(
      { length: 4097 },
      (_, index) => `global/secret_${index.toString().padStart(5, "0")}`,
    );
    expect(jobResultSchema.safeParse({
      ...job,
      metadata: {
        ...job.metadata,
        config_snapshot: {
          ...snapshot,
          settings: manySettings,
          redacted_keys: manyRedactedKeys,
        },
      },
    }).success).toBe(true);
    expect(jobResultSchema.safeParse({
      ...job,
      metadata: {
        ...job.metadata,
        config_snapshot: { ...snapshot, bytes: 524_289 },
      },
    }).success).toBe(false);

    const snapshotWithPayload = (payloadBytes: number) => {
      const settings: Record<string, string> = {};
      let remaining = payloadBytes;
      let index = 0;
      while (remaining > 0) {
        const length = Math.min(65_536, remaining);
        settings[`setting_${index}`] = "x".repeat(length);
        remaining -= length;
        index += 1;
      }
      return { ...snapshot, settings, redacted_keys: [], bytes: 524_288 };
    };
    const finalEnvelopeBytes = (payloadBytes: number) => Buffer.byteLength(
      JSON.stringify(snapshotWithPayload(payloadBytes)),
      "utf8",
    );
    let acceptedPayloadBytes = 0;
    let rejectedPayloadBytes = 524_288;
    while (acceptedPayloadBytes + 1 < rejectedPayloadBytes) {
      const candidate = Math.floor((acceptedPayloadBytes + rejectedPayloadBytes) / 2);
      if (finalEnvelopeBytes(candidate) <= 512 * 1024) {
        acceptedPayloadBytes = candidate;
      } else {
        rejectedPayloadBytes = candidate;
      }
    }
    expect(jobResultSchema.safeParse({
      ...job,
      metadata: {
        ...job.metadata,
        config_snapshot: snapshotWithPayload(acceptedPayloadBytes),
      },
    }).success).toBe(true);
    expect(finalEnvelopeBytes(rejectedPayloadBytes)).toBeGreaterThan(512 * 1024);
    expect(jobResultSchema.safeParse({
      ...job,
      metadata: {
        ...job.metadata,
        config_snapshot: snapshotWithPayload(rejectedPayloadBytes),
      },
    }).success).toBe(false);
  });

  it("allows only preflight-failed project saves to omit the snapshot", () => {
    const base = {
      job_id: "save-1",
      type: "project_save",
      progress: 0,
      project_id: "project-1",
      source_revision: 4,
      warnings: [],
      metadata: { output_path: "part.3mf" },
      result: null,
      error: null,
      revision: 4,
    };

    expect(jobResultSchema.safeParse({ ...base, state: "running" }).success).toBe(false);
    expect(jobResultSchema.safeParse({
      ...base,
      state: "failed",
      error: {
        code: "invalid_request",
        message: "Configuration snapshot exceeds the response size limit",
        details: null,
      },
    }).success).toBe(true);
    expect(jobResultSchema.safeParse({
      ...base,
      state: "failed",
      progress: 1,
      error: {
        code: "invalid_request",
        message: "Configuration snapshot exceeds the response size limit",
        details: null,
      },
    }).success).toBe(false);
    expect(jobResultSchema.safeParse({
      ...base,
      state: "succeeded",
      progress: 1,
      result: { path: "/outputs/part.3mf", bytes: 1024 },
    }).success).toBe(false);
    expect(jobResultSchema.safeParse({
      ...base,
      state: "cancelled",
      error: {
        code: "cancelled",
        message: "Save cancelled",
        details: null,
      },
    }).success).toBe(false);
  });

  it("requires model-import job metadata to be an empty object, never null", () => {
    const base = {
      job_id: "import-1",
      type: "model_import",
      state: "failed",
      progress: 0,
      project_id: "project-1",
      source_revision: 4,
      warnings: [],
      result: null,
      error: {
        code: "model_import_failed",
        message: "Native startup failed",
        details: null,
      },
      revision: 4,
    };

    expect(jobResultSchema.safeParse({ ...base, metadata: {} }).success).toBe(true);
    expect(jobResultSchema.safeParse({ ...base, metadata: null }).success).toBe(false);
  });
});
