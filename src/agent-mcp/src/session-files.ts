import { createHash } from "node:crypto";
import { mkdir, open, rename, rm, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { logApiFailure } from "./diagnostics.js";
import { SessionError } from "./session-store.js";

/** Takes ownership of source, including when destination creation fails. */
export async function copySessionFile(
  source: FileHandle,
  target: string,
  expectedBytes: number,
  maxBytes: number,
  expectedHash?: string,
): Promise<string> {
  let output: FileHandle | undefined;
  let published = false;
  let renamed = false;
  let failed = false;
  const temporary = `${target}.tmp`;
  try {
    const metadata = await source.stat();
    if (
      !metadata.isFile() ||
      metadata.size !== expectedBytes ||
      expectedBytes > maxBytes
    )
      throw new SessionError(
        "artifact_invalid",
        "Session source size or file identity is invalid",
        503,
      );
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    output = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let copied = 0;
    while (copied < expectedBytes) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, expectedBytes - copied),
        copied,
      );
      if (bytesRead === 0)
        throw new SessionError(
          "artifact_invalid",
          "Session source ended before its declared size",
          503,
        );
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await output.writeFile(chunk);
      copied += bytesRead;
    }
    if ((await source.read(buffer, 0, 1, copied)).bytesRead !== 0)
      throw new SessionError(
        "artifact_invalid",
        "Session source grew during copying",
        503,
      );
    const digest = hash.digest("hex");
    if (expectedHash && digest !== expectedHash)
      throw new SessionError(
        "checkpoint_corrupt",
        "Checkpoint checksum is invalid",
        503,
      );
    await output.sync();
    await output.close();
    output = undefined;
    await rename(temporary, target);
    renamed = true;
    const folder = await open(dirname(target), "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
    published = true;
    return digest;
  } catch (error) {
    failed = true;
    logApiFailure("session.file.copy", error);
    throw error;
  } finally {
    const handles = output ? [source, output] : [source];
    const closed = await Promise.allSettled(
      handles.map((handle) => handle.close()),
    );
    const failures = closed.filter(
      (value): value is PromiseRejectedResult => value.status === "rejected",
    );
    for (const failure of failures)
      logApiFailure("session.file.close", failure.reason);
    if (!published) {
      for (const path of renamed ? [temporary, target] : [temporary])
        await rm(path, { force: true }).catch((error: unknown) =>
          logApiFailure("session.file.remove_unpublished", error),
        );
    }
    if (!failed && failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Session file handles did not close",
      );
  }
}
