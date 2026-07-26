import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import {
  BRIDGE_MAX_MESSAGE_SIZE,
  type BridgeErrorPayload,
  type BridgeRequest,
  type BridgeResponse,
} from "./types.js";

export class BridgeError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(error: BridgeErrorPayload) {
    super(error.message);
    this.name = "BridgeError";
    this.code = error.code;
    if (error.details !== undefined) {
      this.details = error.details;
    }
  }
}

export class BridgeProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeProtocolError";
  }
}

export function encodeFrame(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  if (body.length > BRIDGE_MAX_MESSAGE_SIZE) {
    throw new BridgeProtocolError(`Bridge request exceeds ${BRIDGE_MAX_MESSAGE_SIZE} bytes`);
  }
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  append(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const messages: string[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > BRIDGE_MAX_MESSAGE_SIZE) {
        this.buffer = Buffer.alloc(0);
        throw new BridgeProtocolError(`Bridge response exceeds ${BRIDGE_MAX_MESSAGE_SIZE} bytes`);
      }
      if (this.buffer.length < 4 + length) {
        break;
      }
      messages.push(this.buffer.subarray(4, 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(4 + length);
    }
    return messages;
  }
}

function parseResponse(payload: string, expectedId: string): unknown {
  let response: BridgeResponse;
  try {
    response = JSON.parse(payload) as BridgeResponse;
  } catch {
    throw new BridgeProtocolError("Bridge returned invalid JSON");
  }
  if (typeof response !== "object" || response === null || response.id !== expectedId) {
    throw new BridgeProtocolError("Bridge response id does not match the request");
  }
  if ("error" in response) {
    const error = response.error;
    if (
      typeof error !== "object" ||
      error === null ||
      typeof error.code !== "string" ||
      typeof error.message !== "string"
    ) {
      throw new BridgeProtocolError("Bridge returned an invalid error object");
    }
    throw new BridgeError(error);
  }
  if (!("result" in response)) {
    throw new BridgeProtocolError("Bridge response has neither result nor error");
  }
  return response.result;
}

export interface BridgeClientOptions {
  socketPath: string;
  timeoutMs?: number;
  connect?: (path: string) => Socket;
}

export class BridgeClient {
  private readonly socketPath: string;
  private readonly timeoutMs: number;
  private readonly connect: (path: string) => Socket;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: BridgeClientOptions) {
    this.socketPath = options.socketPath;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.connect = options.connect ?? ((path) => createConnection(path));
  }

  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const operation = this.queue.then(() => this.callOnce(method, params));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private callOnce(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = randomUUID();
    const request: BridgeRequest = { id, method, params };
    const frame = encodeFrame(JSON.stringify(request));

    return new Promise((resolve, reject) => {
      const socket = this.connect(this.socketPath);
      const decoder = new FrameDecoder();
      let settled = false;

      const finish = (error?: Error, value?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };

      socket.setTimeout(this.timeoutMs);
      socket.once("connect", () => socket.write(frame));
      socket.on("data", (chunk: Buffer) => {
        try {
          const messages = decoder.append(chunk);
          if (messages.length > 1) {
            finish(new BridgeProtocolError("Bridge returned multiple responses"));
          } else if (messages.length === 1) {
            finish(undefined, parseResponse(messages[0]!, id));
          }
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once("timeout", () => finish(new BridgeProtocolError("Bridge request timed out")));
      socket.once("error", (error) => finish(error));
      socket.once("end", () => finish(new BridgeProtocolError("Bridge closed without a response")));
    });
  }
}
