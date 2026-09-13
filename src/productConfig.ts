// Device-global product configuration for S5.
//
// Scope: DEVICE. Providers configured, default provider/model/endpoint for
// new tasks, custom provider definitions, UI-only preferences that must
// survive restarts. This file NEVER holds secrets: saveProductConfig
// refuses any field whose name looks like a credential, and credentials
// live only in process memory (TaskManager keys) or environment.
//
// Storage: <dataDir>/lattice.product.json, written atomically (temp file +
// rename) so a crash can never leave a half-written config. Unknown future
// schema versions are rejected, never silently downgraded; version 0 or a
// missing file migrates to current defaults.

import fs from "node:fs";
import path from "node:path";

export const PRODUCT_CONFIG_SCHEMA = 1;
export const PRODUCT_CONFIG_FILENAME = "lattice.product.json";

export interface CustomProviderRecord {
  displayName: string;
  baseUrl: string;
  keyRequired: boolean;
}

export interface ProductConfig {
  schemaVersion: number;
  defaultProviderId: string;
  defaultModel: string;
  defaultBaseUrl: string | null;
  customProviders: CustomProviderRecord[];
}

export function defaultProductConfig(): ProductConfig {
  return {
    schemaVersion: PRODUCT_CONFIG_SCHEMA,
    defaultProviderId: "openai",
    defaultModel: "",
    defaultBaseUrl: null,
    customProviders: [],
  };
}

const SECRETISH = /^(api[_-]?key|secret|token|passwd|password|credentials?|access[_-]?token|refresh[_-]?token|private[_-]?key)$/i;

function assertNoSecrets(value: unknown, trail: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => { assertNoSecrets(entry, `${trail}[${index}]`); });
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [field, entry] of Object.entries(value)) {
      if (SECRETISH.test(field)) {
        throw new Error(`product config refuses secret-bearing field: ${trail}.${field}`);
      }
      assertNoSecrets(entry, `${trail}.${field}`);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function sanitizeCustomProviders(value: unknown): CustomProviderRecord[] {
  if (!Array.isArray(value)) return [];
  const records: CustomProviderRecord[] = [];
  for (const entry of value.slice(0, 20)) {
    const record = asRecord(entry);
    const displayName = record?.["displayName"];
    const baseUrl = record?.["baseUrl"];
    const keyRequired = record?.["keyRequired"];
    if (typeof displayName !== "string" || typeof baseUrl !== "string" || typeof keyRequired !== "boolean") continue;
    records.push({ displayName, baseUrl, keyRequired });
  }
  return records;
}

/** Parse + validate + migrate raw file content into a ProductConfig. */
export function parseProductConfig(raw: string): ProductConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("product config is not valid JSON");
  }
  const record = asRecord(parsed);
  if (record === null) throw new Error("product config must be an object");
  const schemaVersion: unknown = record["schemaVersion"];
  if (schemaVersion === undefined) {
    // Version 0 (pre-schema): migrate known fields, drop the rest.
    const migrated = defaultProductConfig();
    if (typeof record["defaultProviderId"] === "string") migrated.defaultProviderId = record["defaultProviderId"];
    if (typeof record["defaultModel"] === "string") migrated.defaultModel = record["defaultModel"];
    return migrated;
  }
  if (schemaVersion !== PRODUCT_CONFIG_SCHEMA) {
    throw new Error("unsupported product config schema: expected 1");
  }
  assertNoSecrets(record, "config");
  const migrated = defaultProductConfig();
  if (typeof record["defaultProviderId"] === "string") migrated.defaultProviderId = record["defaultProviderId"];
  if (typeof record["defaultModel"] === "string") migrated.defaultModel = record["defaultModel"];
  if (typeof record["defaultBaseUrl"] === "string") migrated.defaultBaseUrl = record["defaultBaseUrl"];
  migrated.customProviders = sanitizeCustomProviders(record["customProviders"]);
  return migrated;
}

export function productConfigPath(dataDir: string): string {
  return path.join(dataDir, PRODUCT_CONFIG_FILENAME);
}

export function loadProductConfig(dataDir: string): ProductConfig {
  const file = productConfigPath(dataDir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultProductConfig();
    throw error;
  }
  return parseProductConfig(raw);
}

/** Atomic, secret-refusing write. Throws on secret-bearing fields. */
export function saveProductConfig(dataDir: string, config: ProductConfig): void {
  assertNoSecrets(config, "config");
  const normalized: ProductConfig = {
    schemaVersion: PRODUCT_CONFIG_SCHEMA,
    defaultProviderId: config.defaultProviderId,
    defaultModel: config.defaultModel,
    defaultBaseUrl: config.defaultBaseUrl,
    customProviders: sanitizeCustomProviders(config.customProviders),
  };
  assertNoSecrets(normalized, "config");
  fs.mkdirSync(dataDir, { recursive: true });
  const file = productConfigPath(dataDir);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
}
