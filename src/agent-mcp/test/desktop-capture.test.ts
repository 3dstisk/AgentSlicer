import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutableDesktopCapture } from "../src/desktop-capture.js";

const execFileAsync = promisify(execFile);
const cleanup: string[] = [];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const captureExecutable = join(repositoryRoot, "docker/agent-slicer/capture-orca");

async function testEnvironment(): Promise<{
  bin: string;
  screenshots: string;
  staging: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "capture-orca-test-"));
  cleanup.push(directory);
  const bin = join(directory, "bin");
  const screenshots = join(directory, "screenshots");
  const staging = join(directory, "staging");
  await Promise.all([mkdir(bin), mkdir(screenshots), mkdir(staging)]);
  const commands: Record<string, string> = {
    xdpyinfo: "#!/bin/sh\nexit 0\n",
    xdotool: "#!/bin/sh\nexit 0\n",
    pgrep: "#!/bin/sh\nexit 1\n",
    import: [
      "#!/bin/sh",
      "for argument do output=\"$argument\"; done",
      "if [ \"$output\" = 'png:-' ]; then",
      "  printf 'private capture'",
      "else",
      "  printf 'private capture' > \"$output\"",
      "fi",
      "",
    ].join("\n"),
  };
  await Promise.all(Object.entries(commands).map(async ([name, contents]) => {
    const path = join(bin, name);
    await writeFile(path, contents);
    await chmod(path, 0o755);
  }));
  return { bin, screenshots, staging };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

async function capture(
  environment: Awaited<ReturnType<typeof testEnvironment>>,
  filename: string,
): Promise<string> {
  const { stdout } = await execFileAsync(captureExecutable, [filename], {
    env: {
      ...process.env,
      PATH: `${environment.bin}:${process.env.PATH ?? ""}`,
      DISPLAY: ":99",
      AGENT_SLICER_SCREENSHOT_ROOT: environment.screenshots,
      AGENT_SLICER_CAPTURE_STAGING_ROOT: environment.staging,
      ORCA_INITIAL_CAPTURE_SETTLE_SECONDS: "0",
      ORCA_CAPTURE_SETTLE_SECONDS: "0",
    },
  });
  return stdout.trim();
}

describe("capture-orca", () => {
  it("stages privately and publishes a new screenshot without residue", async () => {
    const environment = await testEnvironment();
    const path = await capture(environment, "desktop.png");

    expect(path).toBe(join(environment.screenshots, "desktop.png"));
    expect(await readFile(path, "utf8")).toBe("private capture");
    expect(await readdir(environment.staging)).toEqual([]);
  });

  it("does not clobber an existing file or symlink", async () => {
    const environment = await testEnvironment();
    const existing = join(environment.screenshots, "existing.png");
    const outside = join(dirname(environment.screenshots), "outside.png");
    await writeFile(existing, "existing");
    await writeFile(outside, "outside");

    await expect(capture(environment, "existing.png")).rejects.toThrow();
    expect(await readFile(existing, "utf8")).toBe("existing");

    const linked = join(environment.screenshots, "linked.png");
    await symlink(outside, linked);
    await expect(capture(environment, "linked.png")).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("outside");
    await expect(access(linked, constants.F_OK)).resolves.toBeUndefined();
    expect(await readdir(environment.staging)).toEqual([]);
  });
});

describe("ExecutableDesktopCapture", () => {
  it("requests bounded PNG stdout without creating a public file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-adapter-test-"));
    cleanup.push(directory);
    const executable = join(directory, "capture");
    await writeFile(executable, [
      "#!/bin/sh",
      "[ \"$1\" = '--stdout' ] || exit 20",
      "[ \"$2\" = 'mcp-desktop.png' ] || exit 21",
      "printf 'png bytes'",
      "",
    ].join("\n"));
    await chmod(executable, 0o755);

    const adapter = new ExecutableDesktopCapture(executable, "/screenshots", 32);
    await expect(adapter.capture("mcp-desktop.png")).resolves.toEqual({
      data: Buffer.from("png bytes"),
      path: "/screenshots/mcp-desktop.png",
    });
    await expect(access(join(directory, "mcp-desktop.png"))).rejects.toThrow();
  });

  it("rejects invalid names and stdout beyond the configured image limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desktop-adapter-test-"));
    cleanup.push(directory);
    const executable = join(directory, "capture");
    await writeFile(executable, "#!/bin/sh\nprintf 'too large'\n");
    await chmod(executable, 0o755);
    const adapter = new ExecutableDesktopCapture(executable, "/screenshots", 4);

    await expect(adapter.capture("../escape.png")).rejects.toThrow("filename is invalid");
    await expect(adapter.capture("capture.png")).rejects.toThrow();
  });
});
