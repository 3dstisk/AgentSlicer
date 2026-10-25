import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGeometryManifest } from "../src/scene-geometry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
function geometry() {
  const manifest = {
    schema_version: 1,
    units: "millimeter",
    up_axis: "Z",
    handedness: "right",
    matrix_order: "column-major",
    winding: "counter-clockwise",
    binary_byte_length: 48,
    meshes: [
      {
        mesh_id: "volume_1",
        vertex_count: 3,
        index_count: 3,
        positions_byte_offset: 0,
        indices_byte_offset: 36,
      },
    ],
    objects: [],
    plates: [],
  };
  let json = JSON.stringify(manifest);
  while (Buffer.byteLength(json) % 4) json += " ";
  const bytes = Buffer.alloc(16 + Buffer.byteLength(json) + 48);
  bytes.write("ASGEOM01");
  bytes.writeUInt32LE(Buffer.byteLength(json), 8);
  bytes.write(json, 16);
  return bytes;
}
describe("native geometry containers", () => {
  it.each([
    "json",
    "schema",
  ])("classifies invalid native %s as an upstream error", async (failure) => {
    const root = await mkdtemp(join(tmpdir(), "scene-validation-test-"));
    roots.push(root);
    const bytes = geometry();
    if (failure === "json") bytes[16] = 0x21;
    else bytes.write("centimeter", bytes.indexOf("millimeter"));
    const path = join(root, "scene.bin");
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    try {
      await expect(
        readGeometryManifest(handle, bytes.length),
      ).rejects.toMatchObject({
        code: "invalid_geometry",
        status: 502,
        cause: expect.any(Error),
      });
    } finally {
      await handle.close();
    }
  });
  it("reads the versioned manifest and locates its binary section", async () => {
    const root = await mkdtemp(join(tmpdir(), "scene-container-test-"));
    roots.push(root);
    const bytes = geometry();
    const path = join(root, "scene.bin");
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    try {
      const result = await readGeometryManifest(handle, bytes.length);
      expect(result.binaryBytes).toBe(48);
      expect(result.binaryOffset + result.binaryBytes).toBe(bytes.length);
    } finally {
      await handle.close();
    }
  });
  it("rejects a truncated or unsupported native container", async () => {
    const root = await mkdtemp(join(tmpdir(), "scene-invalid-test-"));
    roots.push(root);
    const bytes = geometry();
    bytes.write("BADMAGIC");
    const path = join(root, "scene.bin");
    await writeFile(path, bytes);
    const handle = await open(path, "r");
    try {
      await expect(
        readGeometryManifest(handle, bytes.length),
      ).rejects.toMatchObject({ code: "invalid_geometry" });
    } finally {
      await handle.close();
    }
  });
});
