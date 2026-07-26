import {
  access,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readInternalPng, unlinkInternalPng } from "../src/images.js";
import { pngFixture } from "./png-fixture.js";

const PNG = pngFixture(3, 2);
const cleanup: string[] = [];

async function testDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-mcp-images-"));
  cleanup.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("readInternalPng", () => {
  it("returns base64 only for a readable PNG below an allowed root", async () => {
    const directory = await testDirectory();
    const root = join(directory, "root");
    await mkdir(root);
    const path = join(root, "render.png");
    await writeFile(path, PNG);

    await expect(readInternalPng(path, [root], 1024)).resolves.toMatchObject({
      path,
      bytes: PNG.length,
      mimeType: "image/png",
      data: PNG.toString("base64"),
      width: 3,
      height: 2,
    });
  });

  it("rejects traversal and symlink escapes", async () => {
    const directory = await testDirectory();
    const root = join(directory, "root");
    const outside = join(directory, "outside.png");
    await mkdir(root);
    await writeFile(outside, PNG);
    const link = join(root, "linked.png");
    await symlink(outside, link);

    await expect(readInternalPng(outside, [root], 1024)).rejects.toThrow("direct child");
    await expect(readInternalPng(link, [root], 1024)).rejects.toThrow("without symlinks");
  });

  it("rejects nested files and symlinked approved roots", async () => {
    const directory = await testDirectory();
    const root = join(directory, "root");
    const nested = join(root, "nested");
    const rootLink = join(directory, "root-link");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "render.png"), PNG);
    await writeFile(join(root, "render.png"), PNG);
    await symlink(root, rootLink);

    await expect(
      readInternalPng(join(nested, "render.png"), [root], 1024),
    ).rejects.toThrow("direct child");
    await expect(
      readInternalPng(join(rootLink, "render.png"), [rootLink], 1024),
    ).rejects.toThrow("real directory");
  });

  it("rejects fake and oversized PNG files", async () => {
    const directory = await testDirectory();
    const root = join(directory, "root");
    await mkdir(root);
    const fake = join(root, "fake.png");
    const large = join(root, "large.png");
    await writeFile(fake, Buffer.from("not a png"));
    await writeFile(large, Buffer.concat([PNG, Buffer.alloc(100)]));

    await expect(readInternalPng(fake, [root], 1024)).rejects.toThrow("not a PNG");
    await expect(readInternalPng(large, [root], 16)).rejects.toThrow("Screenshot size");
  });

  it("rejects truncated PNGs and impossible IHDR dimensions", async () => {
    const directory = await testDirectory();
    const root = join(directory, "root");
    await mkdir(root);
    const truncated = join(root, "truncated.png");
    const huge = join(root, "huge.png");
    await writeFile(truncated, PNG.subarray(0, PNG.length - 5));
    const oversizedDimensions = pngFixture(20_000, 1);
    await writeFile(huge, oversizedDimensions);

    await expect(readInternalPng(truncated, [root], 1024)).rejects.toThrow(
      /truncated|incomplete/,
    );
    await expect(readInternalPng(huge, [root], 1024)).rejects.toThrow("dimensions");
  });

  it("removes only the opened direct-child inode", async () => {
    const directory = await testDirectory();
    const root = join(directory, "root");
    const outside = join(directory, "outside.png");
    const path = join(root, "render.png");
    const link = join(root, "linked.png");
    await mkdir(root);
    await writeFile(path, PNG);
    await writeFile(outside, PNG);
    await symlink(outside, link);
    const png = await readInternalPng(path, [root], 1024);

    await unlinkInternalPng(path, [root], { expectedFile: png.fileIdentity });
    await expect(access(path)).rejects.toThrow();
    await expect(readInternalPng(link, [root], 1024)).rejects.toThrow("without symlinks");
    await expect(access(outside)).resolves.toBeUndefined();
  });

  it("refuses pathname cleanup without a pinned read identity", async () => {
    const directory = await testDirectory();
    const root = join(directory, "root");
    const path = join(root, "render.png");
    await mkdir(root);
    await writeFile(path, PNG);

    await expect(
      unlinkInternalPng(path, [root], undefined as never),
    ).rejects.toThrow("requires a pinned file identity");
    expect(await readFile(path)).toEqual(PNG);
  });

  it.runIf(process.platform === "linux")(
    "preserves a replacement raced into the cleanup name",
    async () => {
      const directory = await testDirectory();
      const root = join(directory, "root");
      const path = join(root, "render.png");
      const original = join(directory, "original.png");
      const replacement = Buffer.from("replacement must not be deleted");
      await mkdir(root);
      await writeFile(path, PNG);
      await link(path, original);
      const png = await readInternalPng(path, [root], 1024);

      await expect(
        unlinkInternalPng(path, [root], {
          expectedFile: png.fileIdentity,
          async beforeQuarantine() {
            await unlink(path);
            await writeFile(path, replacement);
          },
        }),
      ).rejects.toThrow("replacement preserved");

      expect(await readFile(original)).toEqual(PNG);
      await expect(access(path)).rejects.toThrow();
      const quarantines = (await readdir(root)).filter((entry) =>
        entry.startsWith(".agent-slicer-cleanup-")
      );
      expect(quarantines).toHaveLength(1);
      expect(await readFile(join(root, quarantines[0]!, "capture.png"))).toEqual(replacement);
    },
  );

  it("does not remove a different inode installed after reading", async () => {
    const directory = await testDirectory();
    const root = join(directory, "root");
    const path = join(root, "render.png");
    const replacement = Buffer.from("replacement must remain");
    await mkdir(root);
    await writeFile(path, PNG);
    const png = await readInternalPng(path, [root], 1024);
    await unlink(path);
    await writeFile(path, replacement);

    await expect(
      unlinkInternalPng(path, [root], { expectedFile: png.fileIdentity }),
    ).rejects.toThrow("changed after it was read");
    expect(await readFile(path)).toEqual(replacement);
  });
});
