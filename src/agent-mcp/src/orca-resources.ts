import { open, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import { SessionError } from "./session-store.js";

/** Orca's resources in the worker image (docker/agent-native). */
export const ORCA_RESOURCES_DIR = "/opt/orcaslicer/resources";

/** Only the images printer_get and process_get report: printer covers, bed thumbnails and Orca's SVG icons. */
const RESOURCE_PATTERN =
  /^(?:profiles\/[^/\\\0]+\/[^/\\\0]+_cover\.png|images\/bed_[a-z_]+\.png|images\/[a-z0-9_-]+\.svg)$/;

const notFound = () =>
  new SessionError("resource_not_found", "Resource not found", 404);

/** Opens an allowlisted Orca image read-only, confined to the resources directory. */
export async function openOrcaResource(
  relative: string,
  root = ORCA_RESOURCES_DIR,
) {
  if (!RESOURCE_PATTERN.test(relative) || relative.split("/").includes(".."))
    throw notFound();
  try {
    const base = await realpath(root);
    const path = await realpath(join(base, relative));
    if (!path.startsWith(base + sep)) throw notFound();
    const handle = await open(path, "r");
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      throw notFound();
    }
    return { handle, bytes: info.size };
  } catch (error) {
    if (error instanceof SessionError) throw error;
    throw notFound();
  }
}
