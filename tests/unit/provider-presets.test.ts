import { describe, expect, it } from "vitest";
import {
  buildCustomPreset,
  findPreset,
  isKnownProviderId,
  listPresets,
  resolveBaseUrl,
} from "../../src/providers/presets.js";

describe("provider presets", () => {
  it("lists one shared-protocol preset per supported service", () => {
    const presets = listPresets();
    expect(presets.map((preset) => preset.id)).toEqual(["openai", "openrouter", "gemini", "abacus", "local"]);
    for (const preset of presets) {
      expect(preset.protocol).toBe("openai-compatible");
      expect(preset.defaultBaseUrl).toMatch(/^https?:\/\//);
      expect(preset.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("requires a key everywhere except local", () => {
    for (const preset of listPresets()) {
      expect(preset.keyRequired).toBe(preset.id !== "local");
    }
  });

  it("accepts the custom id and rejects unknown ids", () => {
    expect(isKnownProviderId("custom")).toBe(true);
    expect(isKnownProviderId("openai")).toBe(true);
    expect(isKnownProviderId("openrouter")).toBe(true);
    expect(isKnownProviderId("nope")).toBe(false);
    expect(isKnownProviderId(undefined)).toBe(false);
    expect(isKnownProviderId(42)).toBe(false);
    expect(findPreset("nope")).toBeNull();
  });

  it("resolves explicit base URL overrides after validation", () => {
    const preset = findPreset("local");
    expect(preset?.id).toBe("local");
    if (preset === null) throw new Error("local preset missing");
    expect(resolveBaseUrl(preset, null)).toBe("http://127.0.0.1:8080/v1");
    expect(resolveBaseUrl(preset, "http://127.0.0.1:9999/v1/")).toBe("http://127.0.0.1:9999/v1");
  });

  it("builds custom presets only from safe endpoint input", () => {
    const custom = buildCustomPreset({ displayName: "ACME", baseUrl: "http://10.0.0.2:11434/v1", keyRequired: false });
    expect(custom).toMatchObject({ id: "custom", displayName: "ACME", protocol: "openai-compatible" });
    expect(() => buildCustomPreset({ displayName: "  ", baseUrl: "http://x/v1", keyRequired: false })).toThrow();
    expect(() => buildCustomPreset({ displayName: "X", baseUrl: "not-a-url", keyRequired: false })).toThrow();
    expect(() => buildCustomPreset({ displayName: "X", baseUrl: "ftp://x/v1", keyRequired: false })).toThrow();
    expect(() => buildCustomPreset({ displayName: "X", baseUrl: "http://user:pass@x/v1", keyRequired: false })).toThrow(/credentials/);
  });
});
