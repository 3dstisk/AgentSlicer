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
});
