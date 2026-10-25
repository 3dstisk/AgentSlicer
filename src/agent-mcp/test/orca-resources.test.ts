import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openOrcaResource } from "../src/orca-resources.js";

describe("Orca resources", () => {
  let root = "";
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  const setup = async () => {
    root = await mkdtemp(join(tmpdir(), "orca-resources-"));
    const resources = join(root, "resources");
    await mkdir(join(resources, "profiles", "BBL"), { recursive: true });
    await mkdir(join(resources, "images"), { recursive: true });
    await writeFile(join(resources, "profiles", "BBL", "Bambu Lab A1_cover.png"), "cover");
    await writeFile(join(resources, "images", "bed_pei.png"), "bed");
    await writeFile(join(resources, "images", "param_monotonic.svg"), "<svg/>");
    await writeFile(join(root, "secret_cover.png"), "secret");
    await symlink(join(root, "secret_cover.png"), join(resources, "profiles", "BBL", "Leak_cover.png"));
    return resources;
  };

  it("opens printer covers, bed thumbnails and param icons", async () => {
    const resources = await setup();
    for (const path of ["profiles/BBL/Bambu Lab A1_cover.png", "images/bed_pei.png", "images/param_monotonic.svg"]) {
      const { handle, bytes } = await openOrcaResource(path, resources);
      expect(bytes).toBeGreaterThan(0);
      await handle.close();
    }
  });

  it("rejects other files, traversal and links outside the resources", async () => {
    const resources = await setup();
    for (const path of [
      "profiles/BBL.json",
      "images/bed_pei.svg",
      "images/param_monotonic.png",
      "images/nested/param_monotonic.svg",
      "images/Param.svg",
      "profiles/../../secret_cover.png",
      "profiles/BBL/Leak_cover.png",
      "profiles/BBL/Missing_cover.png",
    ])
      await expect(openOrcaResource(path, resources)).rejects.toMatchObject({ status: 404 });
  });
});
