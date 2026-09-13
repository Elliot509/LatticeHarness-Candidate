import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Pinned external artifacts for the Agent Index bootstrap. Every entry is a
// revision plus a SHA256 of the exact bytes the bootstrap promotes: a marker
// string is never authenticity. Bumps change revision, hash, license note
// and tests together; there is no silent auto-update.
//
// Revisions verified during S4.1-A (see Regras/AGENT_INDEX_BOOTSTRAP.md):
//   agent-index-client @ 87901f8b (HEAD, contains join-on-409 + install-id)
//   plow-agents        @ 8ce907e2 (HEAD, unchanged)
//   agentsview         @ ed20f62f (base of the local Lattice provider patch;
//                        upstream HEAD 7b8c9371 moves only outside our paths)

export interface ToolPin {
  readonly name: "agent-index-client" | "plow-agents" | "agentsview";
  readonly repo: string;
  readonly revision: string;
  readonly artifactPath: string;
  readonly sha256: string;
  readonly license: string;
  readonly licenseFile: string;
}

export const TOOL_PINS: readonly ToolPin[] = [
  {
    name: "agent-index-client",
    repo: "https://github.com/plow-pbc/agent-index-client",
    revision: "87901f8b182a8a7c65ee3dd7267f8f835ee2a545",
    artifactPath: "standalone/agent_index_client.py",
    sha256: "1ebb8ea0917f00a4f74262df112c8bfba9d2502eb7f5a061d5e60fc126967906",
    license: "Apache-2.0",
    licenseFile: "LICENSE",
  },
  {
    name: "plow-agents",
    repo: "https://github.com/plow-pbc/plow-agents",
    revision: "8ce907e220ab67018d6857e8054a41eed4ecd279",
    artifactPath: "bin/plow-agents",
    license: "Apache-2.0",
    licenseFile: "LICENSE",
    sha256: "f69dd0eae74d82f6d9b56b66389c942df35de2665f6d8c92a62ed7b26af223aa",
  },
];

export const PINS_SCHEMA_VERSION = 1;

export interface PinsManifest {
  schemaVersion: 1;
  pins: ToolPin[];
}

// agentsview is NOT a downloaded script: it needs the local Lattice provider
// patch plus a platform build. Its base revision is tracked here so the
// bootstrap can refuse an unknown binary; binaries themselves are never
// fetched silently (see tools.ts).
export const AGENTSVIEW_BASE_REVISION = "ed20f62ffddf304689cfb0fe8fb7dafa2ebd798f";
export const AGENTSVIEW_PATCH_FILES = [
  "agentsview-lattice.go",
  "agentsview-lattice-provider.go",
  "agentsview-lattice_test.go",
  "agentsview-lattice-provider.diff",
] as const;

export function loadPinsManifest(dir: string): PinsManifest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, "pins.json"), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record["schemaVersion"] !== PINS_SCHEMA_VERSION || !Array.isArray(record["pins"])) return null;
  return parsed as PinsManifest;
}

export function writePinsManifest(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const manifest: PinsManifest = {
    schemaVersion: PINS_SCHEMA_VERSION,
    pins: TOOL_PINS.map((pin) => ({ ...pin })),
  };
  fs.writeFileSync(path.join(dir, "pins.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function sha256File(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function verifyFileHash(filePath: string, expected: string): boolean {
  if (expected === "") return false;
  let actual: string;
  try {
    actual = sha256File(filePath);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function bootstrapDirs(dataDir: string): {
  root: string;
  tools: string;
  credentials: string;
  state: string;
  manifests: string;
  logs: string;
} {
  const root = path.join(dataDir, "index", "bootstrap");
  return {
    root,
    tools: path.join(root, "tools"),
    credentials: path.join(root, "credentials"),
    state: path.join(root, "state"),
    manifests: path.join(root, "manifests"),
    logs: path.join(root, "logs"),
  };
}

export function homedir(): string {
  return os.homedir();
}
