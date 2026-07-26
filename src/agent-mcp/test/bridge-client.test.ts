import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BridgeClient,
  BridgeError,
  BridgeProtocolError,
  encodeFrame,
  FrameDecoder,
} from "../src/bridge-client.js";

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()));
});

async function bridgeServer(
  responder: (request: Record<string, unknown>) => Record<string, unknown>,
): Promise<{ socketPath: string; server: Server }> {
  const directory = await mkdtemp(join(tmpdir(), "agent-mcp-bridge-"));
  const socketPath = join(directory, "bridge.sock");
  const server = createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const payload of decoder.append(chunk)) {
        const request = JSON.parse(payload) as Record<string, unknown>;
        const frame = encodeFrame(JSON.stringify(responder(request)));
        socket.write(frame.subarray(0, 3));
        socket.end(frame.subarray(3));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanup.push(
    async () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    () => rm(directory, { recursive: true, force: true }),
  );
  return { socketPath, server };
}

describe("bridge framing", () => {
  it("uses a four-byte big-endian length prefix and decodes fragmented data", () => {
    const frame = encodeFrame('{"ok":true}');
    expect(frame.readUInt32BE(0)).toBe(11);
    const decoder = new FrameDecoder();
    expect(decoder.append(frame.subarray(0, 2))).toEqual([]);
    expect(decoder.append(frame.subarray(2))).toEqual(['{"ok":true}']);
  });

  it("rejects oversized response frames before buffering the body", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1024 * 1024 + 1);
    expect(() => new FrameDecoder().append(header)).toThrow(BridgeProtocolError);
  });
});

describe("BridgeClient", () => {
  it("maps a successful framed response", async () => {
    const { socketPath } = await bridgeServer((request) => ({
      id: request.id,
      result: { ready: true },
    }));
    const client = new BridgeClient({ socketPath, timeoutMs: 1000 });
    await expect(client.call("slicer_status")).resolves.toEqual({ ready: true });
  });

  it("maps native error code, message, and details", async () => {
    const { socketPath } = await bridgeServer((request) => ({
      id: request.id,
      error: {
        code: "revision_conflict",
        message: "Project revision does not match",
        details: { expected_revision: 1, actual_revision: 2 },
      },
    }));
    const client = new BridgeClient({ socketPath, timeoutMs: 1000 });
    const error = await client.call("scene_get").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({
      code: "revision_conflict",
      details: { expected_revision: 1, actual_revision: 2 },
    });
  });

  it("rejects a response with the wrong request id", async () => {
    const { socketPath } = await bridgeServer(() => ({
      id: "other",
      result: {},
    }));
    const client = new BridgeClient({ socketPath, timeoutMs: 1000 });
    await expect(client.call("scene_get")).rejects.toThrow("response id");
  });

  it("continues processing queued calls after a native error", async () => {
    let requestCount = 0;
    const { socketPath } = await bridgeServer((request) => {
      requestCount += 1;
      return requestCount === 1
        ? {
            id: request.id,
            error: {
              code: "invalid_request",
              message: "First request failed",
            },
          }
        : {
            id: request.id,
            result: { ready: true },
          };
    });
    const client = new BridgeClient({ socketPath, timeoutMs: 1000 });

    const first = client.call("scene_get");
    const second = client.call("slicer_status");

    await expect(first).rejects.toMatchObject({ code: "invalid_request" });
    await expect(second).resolves.toEqual({ ready: true });
    expect(requestCount).toBe(2);
  });
});
