import { constants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

const SUPPORTED_OUTPUT_EXTENSIONS = [".gcode", ".3mf"] as const;

function isSupportedOutputFilename(filename: string): boolean {
  return filename.length > 0 &&
    filename.length <= 255 &&
    filename !== "." &&
    filename !== ".." &&
    !filename.includes("\0") &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    SUPPORTED_OUTPUT_EXTENSIONS.some((extension) => filename.endsWith(extension));
}

export interface OpenOutput {
  filename: string;
  bytes: number;
  handle: FileHandle;
}

export class OutputManager {
  constructor(private readonly root: string) {}

  async list(): Promise<string[]> {
    const entries = await readdir(this.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && isSupportedOutputFilename(entry.name))
      .map((entry) => `/outputs/${entry.name}`)
      .sort((left, right) => left.localeCompare(right));
  }

  async open(filename: string): Promise<OpenOutput | undefined> {
    if (!isSupportedOutputFilename(filename)) {
      return undefined;
    }

    let handle: FileHandle;
    try {
      handle = await open(join(this.root, filename), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isUnavailableOutputError(error)) {
        return undefined;
      }
      throw error;
    }

    try {
      const metadata = await handle.stat();
      if (!metadata.isFile()) {
        await handle.close();
        return undefined;
      }
      return { filename, bytes: metadata.size, handle };
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }
}

function isUnavailableOutputError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) {
    return false;
  }
  return ["EACCES", "ELOOP", "ENOENT", "ENOTDIR"].includes(String(error.code));
}
