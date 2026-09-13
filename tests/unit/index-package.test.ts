import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// Tarball hygiene: the distributable must never carry credentials, install
// identities, external clones, future research, or test state. Uses synthetic
// patterns only; no real secret exists in this repo.

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const SECRET_PATTERNS = [
  /aik_[A-Za-z0-9_-]{8,}/,
  /PLOW_AGENT_TOKEN\s*=\s*\S+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /sk-(?:test|live|proj)-[A-Za-z0-9_-]{4,}/,
  /\.agent-index\.json/,
  /credential.*\.env/i,
];

const FORBIDDEN_PATHS = [
  "docs/future",
  ".agent-index",
  "agent-index-client",
  "agentsview-bin",
  "lattice-pack-",
  ".export-",
  "usage.jsonl",
];

describe("distribution hygiene", () => {
  it("packs without secrets, identities, clones, or future research", () => {
    // Windows runners expose npm only as npm.cmd through a shell; POSIX
    // runners spawn npm directly. Same helper the pack script uses.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const out = execFileSync(npm, ["pack", "--dry-run", "--json"], {
      encoding: "utf8",
      timeout: 120000,
      ...(process.platform === "win32" ? { shell: true } : {}),
    });
    const parsed = JSON.parse(out) as Record<string, { files?: Array<{ path?: string }> }>;
    const files = Object.values(parsed)[0]?.files?.map((entry) => entry.path ?? "") ?? [];
    const listing = files.join("\n");
    for (const pattern of SECRET_PATTERNS) {
      expect(listing, `tarball listing matches ${pattern}`).not.toMatch(pattern);
    }
    for (const forbidden of FORBIDDEN_PATHS) {
      expect(files.some((file) => file.includes(forbidden)), `tarball contains ${forbidden}`).toBe(false);
    }
    expect(files).toContain("dist/index/adapter.js");
    expect(files).toContain("dist/cli/index.js");
  });

  it("keeps patch fixtures free of credential-shaped content", () => {
    const patchDir = path.resolve("scripts/index-patches");
    for (const file of fs.readdirSync(patchDir)) {
      const text = fs.readFileSync(path.join(patchDir, file), "utf8");
      for (const pattern of SECRET_PATTERNS.slice(0, 4)) {
        expect(text, `${file} matches ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("keeps index fixtures synthetic", () => {
    const fixtureDir = path.resolve("fixtures/index");
    for (const file of fs.readdirSync(fixtureDir)) {
      const text = fs.readFileSync(path.join(fixtureDir, file), "utf8");
      expect(text).not.toContain("PLOW_AGENT_TOKEN");
      expect(text).not.toContain("aik_");
    }
    expect(dirs).toEqual([]);
  });
});
