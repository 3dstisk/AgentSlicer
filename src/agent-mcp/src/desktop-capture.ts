import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { DesktopCaptureAdapter } from "./types.js";

const execFileAsync = promisify(execFile);

export class ExecutableDesktopCapture implements DesktopCaptureAdapter {
  constructor(
    private readonly executable: string,
    private readonly screenshotRoot: string,
    private readonly maxBytes: number,
  ) {}

  async capture(filename: string): Promise<{ data: Buffer; path: string }> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(filename)) {
      throw new Error("Desktop screenshot filename is invalid");
    }
    const { stdout } = await execFileAsync(this.executable, ["--stdout", filename], {
      shell: false,
      timeout: 90_000,
      maxBuffer: this.maxBytes + 1,
      encoding: "buffer",
    });
    if (stdout.length === 0 || stdout.length > this.maxBytes) {
      throw new Error(`Desktop screenshot exceeds the ${this.maxBytes}-byte limit`);
    }
    return {
      data: stdout,
      path: `${this.screenshotRoot}/${filename}`,
    };
  }
}
