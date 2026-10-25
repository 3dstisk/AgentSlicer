import type { FileHandle } from "node:fs/promises";
import { z } from "zod";
import { BRIDGE_MAX_MESSAGE_SIZE } from "./types.js";
import { SessionError } from "./session-store.js";
import { logApiFailure } from "./diagnostics.js";

const matrix = z.array(z.number().finite()).length(16);
const bounds = z
  .object({
    min_mm: z.array(z.number().finite()).length(3),
    max_mm: z.array(z.number().finite()).length(3),
    size_mm: z.array(z.number().finite()).length(3),
  })
  .nullable();
export const geometryManifestSchema = z.object({
  schema_version: z.literal(1),
  units: z.literal("millimeter"),
  up_axis: z.literal("Z"),
  handedness: z.literal("right"),
  matrix_order: z.literal("column-major"),
  winding: z.literal("counter-clockwise"),
  binary_byte_length: z.number().int().nonnegative(),
  meshes: z.array(
    z.object({
      mesh_id: z.string(),
      vertex_count: z.number().int().nonnegative(),
      index_count: z.number().int().nonnegative(),
      positions_byte_offset: z.number().int().nonnegative(),
      indices_byte_offset: z.number().int().nonnegative(),
    }),
  ),
  objects: z.array(
    z.object({
      object_id: z.string(),
      object_index: z.number().int(),
      name: z.string(),
      // 1-based filament slot; absent from images without object_filament_set.
      filament: z.number().int().positive().optional(),
      bounds,
      volumes: z.array(
        z.object({
          volume_id: z.string(),
          name: z.string(),
          role: z.string(),
          // 0: follows the object's filament.
          filament: z.number().int().nonnegative().optional(),
          mesh_id: z.string(),
          transform: matrix,
        }),
      ),
      instances: z.array(
        z.object({
          instance_id: z.string(),
          instance_index: z.number().int(),
          plate_index: z.number().int(),
          transform: matrix,
          mirrored: z.boolean(),
          bounds,
        }),
      ),
    }),
  ),
  plates: z.array(
    z.object({
      plate_index: z.number().int(),
      name: z.string(),
      // Absent from native images that do not advertise plate_lock.
      locked: z.boolean().optional(),
      origin_mm: z.array(z.number().finite()).length(3).nullable(),
      size_mm: z.array(z.number().finite()).length(3),
    }),
  ),
});

export async function readGeometryManifest(handle: FileHandle, bytes: number) {
  const header = Buffer.alloc(16);
  const first = await handle.read(header, 0, 16, 0);
  const jsonBytes = header.readUInt32LE(8);
  if (
    first.bytesRead !== 16 ||
    header.toString("ascii", 0, 8) !== "ASGEOM01" ||
    header.readUInt32LE(12) !== 0 ||
    jsonBytes === 0 ||
    jsonBytes % 4 !== 0 ||
    jsonBytes > BRIDGE_MAX_MESSAGE_SIZE ||
    jsonBytes + 16 > bytes
  )
    throw new SessionError(
      "invalid_geometry",
      "Native scene geometry header is invalid",
      502,
    );
  const data = Buffer.alloc(jsonBytes);
  const read = await handle.read(data, 0, jsonBytes, 16);
  if (read.bytesRead !== jsonBytes)
    throw new SessionError(
      "invalid_geometry",
      "Geometry manifest is truncated",
      502,
    );
  let value: unknown;
  try {
    value = JSON.parse(data.toString("utf8"));
  } catch (error) {
    logApiFailure("session.geometry.parse_manifest", error);
    throw new SessionError(
      "invalid_geometry",
      "Native geometry JSON is invalid",
      502,
      undefined,
      { cause: error },
    );
  }
  const parsed = geometryManifestSchema.safeParse(value);
  if (!parsed.success)
    throw new SessionError(
      "invalid_geometry",
      "Native geometry manifest has an invalid shape",
      502,
      parsed.error.issues,
      { cause: parsed.error },
    );
  const manifest = parsed.data;
  if (manifest.binary_byte_length !== bytes - 16 - jsonBytes)
    throw new SessionError(
      "invalid_geometry",
      "Geometry binary size differs from its manifest",
      502,
    );
  const meshes = new Map(manifest.meshes.map((mesh) => [mesh.mesh_id, mesh]));
  if (meshes.size !== manifest.meshes.length)
    throw new SessionError(
      "invalid_geometry",
      "Duplicate native mesh identities",
      502,
    );
  let end = 0;
  for (const mesh of manifest.meshes) {
    if (
      mesh.positions_byte_offset !== end ||
      mesh.indices_byte_offset !== end + mesh.vertex_count * 12 ||
      mesh.index_count % 3 !== 0
    )
      throw new SessionError(
        "invalid_geometry",
        "Geometry buffer offsets are invalid",
        502,
      );
    end = mesh.indices_byte_offset + mesh.index_count * 4;
    if (end > manifest.binary_byte_length)
      throw new SessionError(
        "invalid_geometry",
        "Geometry buffer exceeds the artifact",
        502,
      );
  }
  if (end !== manifest.binary_byte_length)
    throw new SessionError(
      "invalid_geometry",
      "Geometry buffer contains unreferenced data",
      502,
    );
  const ids = new Set<string>();
  for (const object of manifest.objects) {
    for (const id of [
      object.object_id,
      ...object.volumes.map((volume) => volume.volume_id),
      ...object.instances.map((instance) => instance.instance_id),
    ]) {
      if (ids.has(id))
        throw new SessionError(
          "invalid_geometry",
          "Duplicate native scene identity",
          502,
        );
      ids.add(id);
    }
    for (const volume of object.volumes)
      if (!meshes.has(volume.mesh_id))
        throw new SessionError(
          "invalid_geometry",
          "Volume references an absent native mesh",
          502,
        );
  }
  return {
    manifest,
    binaryOffset: 16 + jsonBytes,
    binaryBytes: manifest.binary_byte_length,
  };
}
