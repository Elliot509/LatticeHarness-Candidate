import { describe, expect, it } from "vitest";
import {
  loadConfig,
  providerReadiness,
  validateConfig,
  type LatticeConfig,
} from "../../src/config.js";

function validConfig(): LatticeConfig {
  return {
    dataDir: "/tmp/lattice-data",
    workspace: "/tmp/workspace",
    provider: null,
    model: null,
    maxModelAttempts: 50,
    maxTotalTokens: 200000,
    taskExpiryMs: 30 * 60 * 1000,
    commandTimeoutMs: 5 * 60 * 1000,
  };
}

describe("config validation", () => {
  it("accepts a well-formed config", () => {
    expect(validateConfig(validConfig())).toEqual([]);
  });

  it("rejects relative data and workspace dirs", () => {
    const errors = validateConfig({ ...validConfig(), dataDir: "rel", workspace: "rel2" });
    expect(errors).toContain("dataDir must be absolute");
    expect(errors).toContain("workspace must be absolute");
  });

  it("rejects non-positive budgets and timeouts", () => {
    const errors = validateConfig({
      ...validConfig(),
      maxModelAttempts: 0,
      maxTotalTokens: -5,
      taskExpiryMs: 1.5,
      commandTimeoutMs: Number.NaN,
    });
    expect(errors).toHaveLength(4);
  });

  it("rejects blank provider/model names but allows null", () => {
    expect(validateConfig({ ...validConfig(), provider: "  " })).toHaveLength(1);
    expect(validateConfig({ ...validConfig(), model: "" })).toHaveLength(1);
    expect(validateConfig(validConfig())).toEqual([]);
  });

  it("loads defaults and reports provider pending", () => {
    const config = loadConfig({ dataDir: "/abs/data", workspace: "/abs/ws" });
    expect(config.maxModelAttempts).toBe(50);
    expect(config.maxTotalTokens).toBe(200000);
    expect(providerReadiness(config)).toBe("provider-pending");
  });

  it("reports ready only when provider and model are both set", () => {
    const base = loadConfig({ dataDir: "/abs/data", workspace: "/abs/ws" });
    expect(providerReadiness({ ...base, provider: "acme", model: null })).toBe(
      "provider-pending",
    );
    expect(providerReadiness({ ...base, provider: "acme", model: "m1" })).toBe("ready");
  });
});
