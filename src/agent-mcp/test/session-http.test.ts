import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "../src/session-manager.js";
import { createSessionHttp } from "../src/session-http.js";
import { TestNativeEngine } from "./fixtures/session-engine.js";

it("requires session and editing capabilities, streams scoped checkpoints and closes events", async () => {
  const root = await mkdtemp(join(tmpdir(), "session-http-test-"));
  await mkdir(join(root, "outputs"));
  await mkdir(join(root, "workspace"));
  const manager = new SessionManager({
    root: join(root, "sessions"),
    outputRoot: join(root, "outputs"),
    workspaceRoot: join(root, "workspace"),
    engine: new TestNativeEngine(join(root, "outputs")),
    maxBytes: 1024 * 1024,
    uploadTtlMs: 10000,
    leaseTtlMs: 10000,
  });
  const http = createSessionHttp(manager);
  const server = createServer((request, response) => {
    void http.handle(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No test listener");
  const origin = `http://127.0.0.1:${address.port}`;
  let token = "";
  let lease = "";
  const request = (path: string, input?: unknown) =>
    fetch(`${origin}/api/v1/sessions${path}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-slicer-session-token": token,
        "x-agent-slicer-lease-token": lease,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  try {
    const created = await (
      await request("", {
        owner_id: "human",
        creation_key: "http",
        title: "HTTP",
      })
    ).json();
    const id = created.session.id;
    expect((await request(`/${id}`)).status).toBe(403);
    token = created.token;
    const opened = await (
      await request(`/${id}/open`, { actor: { kind: "human", id: "human" } })
    ).json();
    expect((await request(`/${id}/commands/scene_get`, {})).status).toBe(403);
    lease = opened.lease_token;
    expect((await request(`/${id}/commands/scene_get`, {})).status).toBe(200);
    const read = await (await request(`/${id}`)).json();
    expect(read.lease_token).toBeUndefined();
    expect(
      (
        await request(`/${id}/release`, {
          expected_revision: opened.native.revision - 1,
          expected_generation: opened.generation,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/${id}/release`, {
          expected_revision: opened.native.revision,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/${id}/restore-upload`, {
          path: "/workspace/uploads/foreign.3mf",
          expected_revision: opened.native.revision,
        })
      ).status,
    ).toBe(403);
    expect((await (await request(`/${id}`)).json()).native).toEqual(
      opened.native,
    );
    const checkpoint = await request(
      `/${id}/artifacts/${opened.checkpoint.id}`,
    );
    expect(checkpoint.status).toBe(200);
    expect(await checkpoint.json()).toEqual({ value: 0 });
    const events = await request(`/${id}/events`);
    const reader = events.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "retry:",
    );
    await reader.cancel();
    expect(
      (await request(`/${id}/artifacts/00000000-0000-4000-8000-000000000000`))
        .status,
    ).toBe(404);
  } finally {
    http.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
