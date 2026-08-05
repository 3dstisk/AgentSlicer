import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { extname, isAbsolute, join, relative } from "node:path";

const supportedExtensions = new Set([".stl", ".obj", ".3mf", ".step", ".stp"]);
const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface UploadPrepareInput {
  filename: string;
  bytes: number;
  sha256: string;
}

export interface UploadPreparation extends UploadPrepareInput {
  upload_id: string;
  upload_path: string;
  workspace_path: string;
  method: "PUT";
  content_type: "application/octet-stream";
  expires_at: string;
  required_headers: {
    authorization: "Bearer <same token used for MCP>";
    content_type: "application/octet-stream";
    content_length: string;
  };
}

export interface UploadedModel {
  ok: true;
  upload_id: string;
  workspace_path: string;
  bytes: number;
  sha256: string;
}

export interface UploadPreparer {
  readonly maxBytes: number;
  readonly ttlMs: number;
  prepare(input: UploadPrepareInput): Promise<UploadPreparation>;
}

interface UploadTicket extends UploadPreparation {
  expiresAtMs: number;
  storedFilename: string;
}

export class UploadError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

export function isSupportedUploadFilename(filename: string): boolean {
  if (
    filename.length === 0 ||
    Buffer.byteLength(filename, "utf8") > 255 ||
    filename === "." ||
    filename === ".." ||
    filename.includes("\0") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return false;
  }
  return supportedExtensions.has(extname(filename).toLowerCase());
}

export function isUploadId(value: string): boolean {
  return uploadIdPattern.test(value);
}

function safeStorageError(): UploadError {
  return new UploadError("upload_storage_error", 500, "Upload storage is unavailable");
}

export class UploadManager implements UploadPreparer {
  readonly maxBytes: number;
  readonly ttlMs: number;

  private readonly tickets = new Map<string, UploadTicket>();
  private uploadDirectoryPromise?: Promise<string>;

  constructor(
    private readonly workspaceRoot: string,
    maxBytes: number,
    ttlMs: number,
  ) {
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
  }

  async prepare(input: UploadPrepareInput): Promise<UploadPreparation> {
    this.validatePreparation(input);
    try {
      await this.uploadDirectory();
    } catch (error) {
      if (error instanceof UploadError) {
        throw error;
      }
      throw safeStorageError();
    }

    const now = Date.now();
    this.removeExpired(now);
    const uploadId = randomUUID();
    const extension = extname(input.filename).toLowerCase();
    const storedFilename = `${uploadId}${extension}`;
    const expiresAtMs = now + this.ttlMs;
    const preparation: UploadTicket = {
      ...input,
      sha256: input.sha256.toLowerCase(),
      upload_id: uploadId,
      upload_path: `/uploads/${uploadId}`,
      workspace_path: `/workspace/uploads/${storedFilename}`,
      method: "PUT",
      content_type: "application/octet-stream",
      expires_at: new Date(expiresAtMs).toISOString(),
      required_headers: {
        authorization: "Bearer <same token used for MCP>",
        content_type: "application/octet-stream",
        content_length: String(input.bytes),
      },
      expiresAtMs,
      storedFilename,
    };
    this.tickets.set(uploadId, preparation);
    return {
      filename: preparation.filename,
      bytes: preparation.bytes,
      sha256: preparation.sha256,
      upload_id: preparation.upload_id,
      upload_path: preparation.upload_path,
      workspace_path: preparation.workspace_path,
      method: preparation.method,
      content_type: preparation.content_type,
      expires_at: preparation.expires_at,
      required_headers: preparation.required_headers,
    };
  }

  async receive(uploadId: string, request: IncomingMessage): Promise<UploadedModel> {
    const ticket = this.claim(uploadId);
    const uploadDirectory = await this.uploadDirectory().catch(() => {
      throw safeStorageError();
    });
    const temporaryPath = join(uploadDirectory, `.upload-${ticket.upload_id}.part`);
    const finalPath = join(uploadDirectory, ticket.storedFilename);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;

    try {
      const contentType = request.headers["content-type"];
      if (contentType !== "application/octet-stream") {
        throw new UploadError(
          "invalid_content_type",
          415,
          "Content-Type must be application/octet-stream",
        );
      }
      const contentLength = request.headers["content-length"];
      if (
        contentLength === undefined ||
        Array.isArray(contentLength) ||
        !/^\d+$/.test(contentLength) ||
        Number(contentLength) !== ticket.bytes
      ) {
        throw new UploadError(
          "content_length_mismatch",
          400,
          "Content-Length must exactly match upload_prepare bytes",
        );
      }

      handle = await open(
        temporaryPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      let totalBytes = 0;
      let position = 0;
      for await (const piece of request) {
        const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
        totalBytes += chunk.length;
        if (totalBytes > ticket.bytes || totalBytes > this.maxBytes) {
          throw new UploadError("upload_too_large", 413, "Upload exceeds the prepared size");
        }
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(
            chunk,
            offset,
            chunk.length - offset,
            position,
          );
          if (bytesWritten === 0) {
            throw safeStorageError();
          }
          offset += bytesWritten;
          position += bytesWritten;
        }
      }
      if (totalBytes !== ticket.bytes) {
        throw new UploadError(
          "content_length_mismatch",
          400,
          "Uploaded bytes do not match upload_prepare bytes",
        );
      }
      const digest = hash.digest("hex");
      if (digest !== ticket.sha256) {
        throw new UploadError(
          "checksum_mismatch",
          422,
          "Uploaded SHA-256 does not match upload_prepare sha256",
        );
      }

      await handle.sync();
      await handle.close();
      handle = undefined;
      await link(temporaryPath, finalPath);
      published = true;
      await unlink(temporaryPath).catch(() => undefined);
      return {
        ok: true,
        upload_id: ticket.upload_id,
        workspace_path: ticket.workspace_path,
        bytes: ticket.bytes,
        sha256: ticket.sha256,
      };
    } catch (error) {
      request.resume();
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof UploadError) {
        throw error;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        throw new UploadError("upload_conflict", 409, "Upload destination already exists");
      }
      if (published) {
        return {
          ok: true,
          upload_id: ticket.upload_id,
          workspace_path: ticket.workspace_path,
          bytes: ticket.bytes,
          sha256: ticket.sha256,
        };
      }
      throw safeStorageError();
    }
  }

  private validatePreparation(input: UploadPrepareInput): void {
    if (!isSupportedUploadFilename(input.filename)) {
      throw new UploadError(
        "invalid_filename",
        400,
        "filename must be a root-level STL, OBJ, 3MF, STEP, or STP filename",
      );
    }
    if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
      throw new UploadError("invalid_size", 400, "bytes must be a positive integer");
    }
    if (input.bytes > this.maxBytes) {
      throw new UploadError(
        "upload_too_large",
        413,
        `Upload exceeds the configured ${this.maxBytes} byte limit`,
      );
    }
    if (!/^[0-9a-f]{64}$/i.test(input.sha256)) {
      throw new UploadError("invalid_checksum", 400, "sha256 must contain 64 hexadecimal digits");
    }
  }

  private claim(uploadId: string): UploadTicket {
    const now = Date.now();
    const ticket = this.tickets.get(uploadId);
    this.removeExpired(now);
    if (ticket === undefined || ticket.expiresAtMs <= now) {
      throw new UploadError("upload_not_found", 404, "Upload ticket was not found or expired");
    }
    this.tickets.delete(uploadId);
    return ticket;
  }

  private removeExpired(now: number): void {
    for (const [uploadId, ticket] of this.tickets) {
      if (ticket.expiresAtMs <= now) {
        this.tickets.delete(uploadId);
      }
    }
  }

  private uploadDirectory(): Promise<string> {
    this.uploadDirectoryPromise ??= this.initializeUploadDirectory().catch((error) => {
      this.uploadDirectoryPromise = undefined;
      throw error;
    });
    return this.uploadDirectoryPromise;
  }

  private async initializeUploadDirectory(): Promise<string> {
    await mkdir(this.workspaceRoot, { recursive: true, mode: 0o700 });
    const workspaceInfo = await lstat(this.workspaceRoot);
    if (!workspaceInfo.isDirectory() || workspaceInfo.isSymbolicLink()) {
      throw safeStorageError();
    }
    const resolvedWorkspace = await realpath(this.workspaceRoot);
    const directory = join(resolvedWorkspace, "uploads");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const directoryInfo = await lstat(directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw safeStorageError();
    }
    const resolvedDirectory = await realpath(directory);
    const relativeDirectory = relative(resolvedWorkspace, resolvedDirectory);
    const escapesWorkspace = relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relativeDirectory);
    if (escapesWorkspace) {
      throw safeStorageError();
    }
    return resolvedDirectory;
  }
}
