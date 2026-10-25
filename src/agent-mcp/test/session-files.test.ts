import { createHash } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { copySessionFile } from "../src/session-files.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
describe("durable checkpoint copying", () => {
  it("copies multiple chunks, checks their hash and closes the owned source", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-copy-test-"));
    roots.push(root);
    const bytes = Buffer.alloc(190_000, 0x5a);
    const source = join(root, "source");
    await writeFile(source, bytes);
    const handle = await open(source, "r");
    const target = join(root, "checkpoint");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(
      await copySessionFile(handle, target, bytes.length, bytes.length, sha256),
    ).toBe(sha256);
    expect(await readFile(target)).toEqual(bytes);
    await expect(handle.stat()).rejects.toThrow();
  });
  it("rejects size/checksum mismatches and removes unpublished temporaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-copy-invalid-test-"));
    roots.push(root);
    const source = join(root, "source");
    await writeFile(source, "checkpoint");
    await expect(
      copySessionFile(
        await open(source, "r"),
        join(root, "wrong-size"),
        9,
        100,
      ),
    ).rejects.toMatchObject({ code: "artifact_invalid" });
    await expect(
      copySessionFile(
        await open(source, "r"),
        join(root, "wrong-hash"),
        10,
        100,
        "bad-checksum",
      ),
    ).rejects.toMatchObject({ code: "checkpoint_corrupt" });
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("closes both handles and removes the renamed copy when directory sync fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "session-copy-sync-test-"));
    roots.push(root);
    const source = join(root, "source");
    await writeFile(source, "checkpoint");
    const handle = await open(source, "r");
    const prototype = Object.getPrototypeOf(handle) as {
      sync(): Promise<void>;
    };
    const sync = prototype.sync;
    let calls = 0;
    const failure = vi.spyOn(prototype, "sync").mockImplementation(function (
      this: typeof prototype,
    ) {
      if (++calls === 2)
        return Promise.reject(new Error("directory sync failed"));
      return sync.call(this);
    });
    try {
      await expect(
        copySessionFile(handle, join(root, "checkpoint"), 10, 100),
      ).rejects.toThrow("directory sync failed");
      expect(await readdir(root)).toEqual(["source"]);
      await expect(handle.stat()).rejects.toThrow();
    } finally {
      failure.mockRestore();
    }
  });
});
