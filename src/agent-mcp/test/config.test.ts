import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("MCP configuration security", () => {
  it("allows loopback binding without a token", () => {
    expect(loadConfig({ AGENT_SLICER_MCP_HOST: "127.0.0.2" }).bindHost).toBe("127.0.0.2");
    expect(loadConfig({ AGENT_SLICER_MCP_HOST: "::1" }).bindHost).toBe("::1");
  });

  it("requires authentication for non-loopback binding", () => {
    expect(() => loadConfig({ AGENT_SLICER_MCP_HOST: "0.0.0.0" })).toThrow(
      "AGENT_SLICER_TOKEN",
    );
    expect(
      loadConfig({
        AGENT_SLICER_MCP_HOST: "0.0.0.0",
        AGENT_SLICER_TOKEN: "deployment-secret",
      }).bearerToken,
    ).toBe("deployment-secret");
  });

  it("configures bounded uploads alongside the native import limit", () => {
    const inherited = loadConfig({ AGENT_SLICER_MAX_IMPORT_BYTES: "4096" });
    expect(inherited.maxUploadBytes).toBe(4096);
    expect(inherited.workspaceRoot).toBe("/workspace");
    expect(inherited.outputRoot).toBe("/outputs");
    expect(inherited.uploadTtlMs).toBe(15 * 60 * 1000);

    const overridden = loadConfig({
      AGENT_SLICER_MAX_IMPORT_BYTES: "4096",
      AGENT_SLICER_MAX_UPLOAD_BYTES: "2048",
      AGENT_SLICER_UPLOAD_TTL_MS: "60000",
    });
    expect(overridden.workspaceRoot).toBe("/workspace");
    expect(overridden.maxUploadBytes).toBe(2048);
    expect(overridden.uploadTtlMs).toBe(60_000);
    expect(() => loadConfig({ AGENT_SLICER_UPLOAD_TTL_MS: "86400001" })).toThrow(
      "at most 86400000",
    );
  });
});
