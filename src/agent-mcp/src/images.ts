import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  rename,
  rmdir,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngImage {
  data: string;
  mimeType: "image/png";
  path: string;
  bytes: number;
  width: number;
  height: number;
  fileIdentity: PinnedFileIdentity;
}

export interface PinnedFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface UnlinkInternalPngOptions {
  beforeQuarantine?: () => Promise<void>;
  /**
   * The file identity obtained from a completed readInternalPng call.
   * Cleanup by pathname without this proof would risk deleting a replacement.
   */
  expectedFile: PinnedFileIdentity;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function parsePng(file: Buffer): { width: number; height: number } {
  if (!file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("Screenshot is not a PNG file");
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let chunkIndex = 0;
  let sawImageData = false;
  let sawEnd = false;
  while (offset < file.length) {
    if (file.length - offset < 12) {
      throw new Error("Screenshot PNG is truncated");
    }
    const length = file.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = typeStart + 4;
    const crcOffset = dataStart + length;
    const nextOffset = crcOffset + 4;
    if (nextOffset > file.length) {
      throw new Error("Screenshot PNG is truncated");
    }
    const type = file.toString("ascii", typeStart, dataStart);
    if (!/^[A-Za-z]{4}$/.test(type)) {
      throw new Error("Screenshot PNG contains an invalid chunk type");
    }
    const expectedCrc = file.readUInt32BE(crcOffset);
    const actualCrc = crc32(file.subarray(typeStart, crcOffset));
    if (actualCrc !== expectedCrc) {
      throw new Error(`Screenshot PNG ${type} chunk has an invalid CRC`);
    }

    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) {
        throw new Error("Screenshot PNG must begin with a complete IHDR chunk");
      }
      width = file.readUInt32BE(dataStart);
      height = file.readUInt32BE(dataStart + 4);
      if (width === 0 || height === 0 || width > 16_384 || height > 16_384 ||
          width * height > 100_000_000) {
        throw new Error("Screenshot PNG dimensions are invalid or too large");
      }
    } else if (type === "IHDR") {
      throw new Error("Screenshot PNG contains multiple IHDR chunks");
    }

    if (type === "IDAT") {
      sawImageData = true;
    }
    if (type === "IEND") {
      if (length !== 0 || !sawImageData || nextOffset !== file.length) {
        throw new Error("Screenshot PNG has an invalid or incomplete IEND chunk");
      }
      sawEnd = true;
      offset = nextOffset;
      break;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  if (!sawEnd) {
    throw new Error("Screenshot PNG is incomplete");
  }
  return { width, height };
}

interface PinnedDirectChild {
  file: FileHandle;
  path: string;
  root: FileHandle;
}

function sameFile(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(
  left: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
  right: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">,
): boolean {
  return sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function directChildRoot(
  requestedPath: string,
  allowedRoots: readonly string[],
): string {
  if (!isAbsolute(requestedPath) || resolve(requestedPath) !== requestedPath) {
    throw new Error("Screenshot path must be absolute and normalized");
  }
  if (!requestedPath.toLowerCase().endsWith(".png")) {
    throw new Error("Screenshot path must use the .png extension");
  }
  for (const root of allowedRoots) {
    if (!isAbsolute(root) || resolve(root) !== root) {
      throw new Error("Screenshot root must be absolute and normalized");
    }
    if (dirname(requestedPath) === root && basename(requestedPath) !== "") {
      return root;
    }
  }
  throw new Error("Screenshot path must be a direct child of an approved root");
}

async function openPinnedDirectChild(
  requestedPath: string,
  allowedRoots: readonly string[],
): Promise<PinnedDirectChild> {
  const rootPath = directChildRoot(requestedPath, allowedRoots);
  let root: FileHandle;
  try {
    root = await open(
      rootPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw new Error("Screenshot root must be a real directory");
  }
  try {
    const pinnedRoot = await root.stat();
    if (!pinnedRoot.isDirectory()) {
      throw new Error("Screenshot root must be a real directory");
    }
    const childPath = process.platform === "linux"
      ? `/proc/self/fd/${root.fd}/${basename(requestedPath)}`
      : requestedPath;
    let file: FileHandle;
    try {
      file = await open(childPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error("Screenshot path must be a regular file without symlinks");
    }
    try {
      const currentRoot = await stat(rootPath);
      if (!sameFile(pinnedRoot, currentRoot)) {
        throw new Error("Screenshot root changed while opening the file");
      }
      return { file, path: requestedPath, root };
    } catch (error) {
      await file.close();
      throw error;
    }
  } catch (error) {
    await root.close();
    throw error;
  }
}

async function readPinnedFile(file: FileHandle, size: number): Promise<Buffer> {
  const data = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < data.length) {
    const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
    if (bytesRead === 0) {
      throw new Error("Screenshot changed while it was being read");
    }
    offset += bytesRead;
  }
  return data;
}

export async function readInternalPng(
  requestedPath: string,
  allowedRoots: readonly string[],
  maxBytes: number,
): Promise<PngImage> {
  const pinned = await openPinnedDirectChild(requestedPath, allowedRoots);
  try {
    const before = await pinned.file.stat();
    if (!before.isFile()) {
      throw new Error("Screenshot path is not a regular file");
    }
    if (before.size <= PNG_SIGNATURE.length || before.size > maxBytes) {
      throw new Error(`Screenshot size must be between 9 and ${maxBytes} bytes`);
    }
    const file = await readPinnedFile(pinned.file, before.size);
    const after = await pinned.file.stat();
    if (!sameSnapshot(before, after)) {
      throw new Error("Screenshot changed while it was being read");
    }
    const dimensions = parsePng(file);
    return {
      data: file.toString("base64"),
      mimeType: "image/png",
      path: pinned.path,
      bytes: file.length,
      fileIdentity: {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        ctimeMs: before.ctimeMs,
      },
      ...dimensions,
    };
  } finally {
    await Promise.all([pinned.file.close(), pinned.root.close()]);
  }
}

export function readPngBuffer(
  file: Buffer,
  path: string,
  maxBytes: number,
): Omit<PngImage, "fileIdentity"> {
  if (file.length <= PNG_SIGNATURE.length || file.length > maxBytes) {
    throw new Error(`Screenshot size must be between 9 and ${maxBytes} bytes`);
  }
  const dimensions = parsePng(file);
  return {
    data: file.toString("base64"),
    mimeType: "image/png",
    path,
    bytes: file.length,
    ...dimensions,
  };
}

export async function unlinkInternalPng(
  requestedPath: string,
  allowedRoots: readonly string[],
  options: UnlinkInternalPngOptions,
): Promise<void> {
  // Keep this runtime check even though TypeScript makes the token required:
  // the cleanup function is also a process boundary that could be called from
  // untyped JavaScript.
  if (options?.expectedFile === undefined) {
    throw new Error("Screenshot cleanup requires a pinned file identity");
  }
  const pinned = await openPinnedDirectChild(requestedPath, allowedRoots);
  let quarantine: FileHandle | undefined;
  let quarantinePath: string | undefined;
  let quarantineIsEmpty = false;
  try {
    const openedFile = await pinned.file.stat();
    if (!openedFile.isFile()) {
      throw new Error("Screenshot cleanup target must be a regular file");
    }
    if (!sameSnapshot(options.expectedFile, openedFile)) {
      throw new Error("Screenshot cleanup target changed after it was read");
    }
    if (process.platform === "linux") {
      await options.beforeQuarantine?.();
      const rootPath = directChildRoot(requestedPath, allowedRoots);
      quarantinePath = await mkdtemp(join(rootPath, ".agent-slicer-cleanup-"));
      quarantine = await open(
        quarantinePath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const quarantineStat = await quarantine.stat();
      const currentQuarantine = await lstat(quarantinePath);
      if (!quarantineStat.isDirectory() || !sameFile(quarantineStat, currentQuarantine)) {
        throw new Error("Screenshot cleanup quarantine changed while opening");
      }

      const source = `/proc/self/fd/${pinned.root.fd}/${basename(requestedPath)}`;
      const quarantined = `/proc/self/fd/${quarantine.fd}/capture.png`;
      await rename(source, quarantined);
      const movedFile = await lstat(quarantined);
      if (!movedFile.isFile() || movedFile.isSymbolicLink() ||
          !sameFile(openedFile, movedFile)) {
        throw new Error(
          `Screenshot cleanup target changed; replacement preserved in ${quarantinePath}`,
        );
      }
      await unlink(quarantined);
      quarantineIsEmpty = true;
      return;
    }

    const unlinkPath = requestedPath;
    const currentFile = await lstat(unlinkPath);
    if (!currentFile.isFile() || currentFile.isSymbolicLink() ||
        !sameFile(openedFile, currentFile)) {
      throw new Error("Screenshot cleanup target changed before removal");
    }
    await unlink(unlinkPath);
  } finally {
    await Promise.all([
      pinned.file.close(),
      pinned.root.close(),
      ...(quarantine === undefined ? [] : [quarantine.close()]),
    ]);
    if (quarantinePath !== undefined && quarantineIsEmpty) {
      await rmdir(quarantinePath);
    }
  }
}
