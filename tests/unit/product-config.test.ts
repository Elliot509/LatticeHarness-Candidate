import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultProductConfig,
  loadProductConfig,
  parseProductConfig,
  PRODUCT_CONFIG_FILENAME,
  saveProductConfig,
} from "../../src/productConfig.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-product-"));
  dirs.push(dir);
  return dir;
}

describe("product config", () => {
  it("starts from deterministic defaults when no file exists", () => {
    expect(loadProductConfig(tempDir())).toEqual({
      schemaVersion: 1,
      defaultProviderId: "openai",
      defaultModel: "",
      defaultBaseUrl: null,
      customProviders: [],
    });
  });

  it("round-trips through an atomic write with no temp file left behind", () => {
    const dir = tempDir();
    saveProductConfig(dir, {
      ...defaultProductConfig(),
      defaultProviderId: "local",
      defaultModel: "m",
      defaultBaseUrl: "http://127.0.0.1:8080/v1",
      customProviders: [{ displayName: "ACME", baseUrl: "http://10.0.0.2/v1", keyRequired: true }],
    });
    expect(loadProductConfig(dir).defaultProviderId).toBe("local");
    expect(fs.readdirSync(dir)).toEqual([PRODUCT_CONFIG_FILENAME]);
  });

  it("refuses secret-bearing fields instead of persisting them", () => {
    const dir = tempDir();
    expect(() => saveProductConfig(dir, {
      ...defaultProductConfig(),
      customProviders: [{ displayName: "X", baseUrl: "http://x/v1", keyRequired: false, apiKey: "sk-live" } as never],
    })).toThrow(/secret-bearing field/);
    expect(fs.existsSync(path.join(dir, PRODUCT_CONFIG_FILENAME))).toBe(false);
    expect(() => parseProductConfig(JSON.stringify({ schemaVersion: 1, apiKey: "sk-live" }))).toThrow(/secret-bearing field/);
  });

  it("rejects future schemas and migrates versionless files", () => {
    expect(() => parseProductConfig(JSON.stringify({ schemaVersion: 99 }))).toThrow(/unsupported product config schema/);
    expect(() => parseProductConfig("not json{{")).toThrow(/not valid JSON/);
    const migrated = parseProductConfig(JSON.stringify({ defaultProviderId: "local", defaultModel: "m", extra: true }));
    expect(migrated).toMatchObject({ schemaVersion: 1, defaultProviderId: "local", defaultModel: "m" });
  });

  it("survives a crash mid-write by keeping the last complete file", () => {
    const dir = tempDir();
    saveProductConfig(dir, { ...defaultProductConfig(), defaultModel: "first" });
    // Simulate a crashed writer: temp file present, main file untouched.
    fs.writeFileSync(path.join(dir, `${PRODUCT_CONFIG_FILENAME}.123.tmp`), "partial", "utf8");
    expect(loadProductConfig(dir).defaultModel).toBe("first");
  });
});
