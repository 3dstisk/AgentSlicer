import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/session-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("durable session records", () => {
  it("recovers records and session capabilities after closing and reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-session-test-"));
    roots.push(root);
    let store = await SessionStore.open(root);
    const created = store.create("operator-a", "draft-1", "Resume fixture");
    const originalToken = store.token(created.id);
    expect(store.authorize(created.id, originalToken).id).toBe(created.id);
    expect(() =>
      store.authorize(created.id, store.token("another-session")),
    ).toThrow("Session access denied");
    expect(store.list("operator-b")).toEqual([]);
    expect(store.create("operator-a", "draft-1", "Repeated creation").id).toBe(
      created.id,
    );
    store.close();
    store = await SessionStore.open(root);
    expect(store.token(created.id)).toBe(originalToken);
    expect(store.list("operator-a")[0]?.title).toBe("Resume fixture");
    store.close();
  });

  it("prevents a second adapter from taking the same session store", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-session-lock-test-"));
    roots.push(root);
    const first = await SessionStore.open(root);
    await expect(SessionStore.open(root)).rejects.toThrow();
    first.close();
    const replacement = await SessionStore.open(root);
    replacement.close();
  });
  it("rejects malformed or missing keys without rotating persisted capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-session-key-test-"));
    roots.push(root);
    const store = await SessionStore.open(root);
    store.create("owner", "draft", "Key fixture");
    store.close();
    await writeFile(join(root, "capability.key"), Buffer.alloc(33));
    await expect(SessionStore.open(root)).rejects.toThrow();
    await unlink(join(root, "capability.key"));
    await expect(SessionStore.open(root)).rejects.toThrow();
  });
});
