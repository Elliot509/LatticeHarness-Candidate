import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENTSVIEW_BASE_REVISION, TOOL_PINS, loadPinsManifest, verifyFileHash, writePinsManifest } from "../../src/index/pins.js";
import { downloadVerified, platformId, resolvePython } from "../../src/index/tools.js";
import { writePrivateFile } from "../../src/index/credentials.js";
import { advanceSetup, loadSetupState } from "../../src/index/setup.js";
import { systemdUnits, windowsTaskXml, writeSchedulerDefinitions } from "../../src/index/scheduler.js";
import { loginArgv, plowLines, plowMint } from "../../src/index/plow.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-s41a-"));
  dirs.push(dir);
  return dir;
}

describe("pins manifest", () => {
  it("round-trips pins with revision and hash, and verifies bytes", () => {
    const dir = freshDir();
    writePinsManifest(dir);
    const manifest = loadPinsManifest(dir);
    expect(manifest?.schemaVersion).toBe(1);
    expect(manifest?.pins).toHaveLength(2);
    for (const pin of TOOL_PINS) {
      expect(pin.revision).toMatch(/^[0-9a-f]{7,64}$/);
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(AGENTSVIEW_BASE_REVISION).toMatch(/^[0-9a-f]{40}$/);
    const file = path.join(dir, "probe.bin");
    fs.writeFileSync(file, "lattice-bootstrap-bytes");
    expect(verifyFileHash(file, "5f4c8d0b4e6d5b8a3b1f0b6e7c9e0a1b2c3d4e5f60718293a4b5c6d7e8f90a1")).toBe(false);
    expect(verifyFileHash(file, "00")).toBe(false);
    expect(verifyFileHash(path.join(dir, "missing"), "00")).toBe(false);
    expect(loadPinsManifest(path.join(dir, "missing-dir"))).toBeNull();
  });
});

describe("verified download", () => {
  const BYTES = Buffer.from("pinned-artifact-bytes");

  it("promotes verified bytes atomically and is idempotent", async () => {
    const { createHash } = await import("node:crypto");
    const real = createHash("sha256").update(BYTES).digest("hex");
    const dir = freshDir();
    const dest = path.join(dir, "sub dir", "client.py");
    let calls = 0;
    const fetch = async (url: string): Promise<Buffer> => {
      calls += 1;
      expect(url.startsWith("https://raw.githubusercontent.com/")).toBe(true);
      return BYTES;
    };
    const first = await downloadVerified({
      repo: "https://github.com/plow-pbc/agent-index-client",
      revision: "87901f8b182a8a7c65ee3dd7267f8f835ee2a545",
      artifactPath: "standalone/agent_index_client.py",
      sha256: real,
      destPath: dest,
      fetch,
    });
    expect(first).toEqual({ downloaded: true });
    expect(fs.readFileSync(dest).equals(BYTES)).toBe(true);
    const second = await downloadVerified({
      repo: "https://github.com/plow-pbc/agent-index-client",
      revision: "87901f8b182a8a7c65ee3dd7267f8f835ee2a545",
      artifactPath: "standalone/agent_index_client.py",
      sha256: real,
      destPath: dest,
      fetch,
    });
    expect(second).toEqual({ downloaded: false });
    expect(calls).toBe(1);
  });

  it("refuses mismatch, unknown pin, bad origin and leaves no partial", async () => {
    const dir = freshDir();
    const dest = path.join(dir, "client.py");
    await expect(
      downloadVerified({
        repo: "https://github.com/plow-pbc/agent-index-client",
        revision: "87901f8b182a8a7c65ee3dd7267f8f835ee2a545",
        artifactPath: "standalone/agent_index_client.py",
        sha256: "0".repeat(64),
        destPath: dest,
        fetch: async () => BYTES,
      }),
    ).rejects.toThrow(/hash mismatch/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
    await expect(
      downloadVerified({
        repo: "https://github.com/plow-pbc/agent-index-client",
        revision: "87901f8b182a8a7c65ee3dd7267f8f835ee2a545",
        artifactPath: "standalone/agent_index_client.py",
        sha256: "",
        destPath: dest,
      }),
    ).rejects.toThrow(/pinned SHA256/);
    await expect(
      downloadVerified({
        repo: "http://evil.example.com/x",
        revision: "87901f8b182a8a7c65ee3dd7267f8f835ee2a545",
        artifactPath: "standalone/agent_index_client.py",
        sha256: "0".repeat(64),
        destPath: dest,
      }),
    ).rejects.toThrow(/known github repo|non-HTTPS/);
  });

  it("resolves python explicitly and reports absence without executing", async () => {
    expect(await resolvePython("/nonexistent/python-xyz")).toEqual({
      error: expect.stringContaining("python3"),
    });
    expect(platformId("linux", "x64")).toBe("linux-x64");
  });
});

describe("private credentials", () => {
  it("writes atomically with restrictive mode and cleans up on failure", async () => {
    const dir = freshDir();
    const creds = path.join(dir, "my creds", "café");
    const dest = await writePrivateFile(creds, "plow-credentials", "PLOW_AGENT_TOKEN=s3cret\n");
    expect(fs.readFileSync(dest, "utf8")).toContain("PLOW_AGENT_TOKEN=");
    if (process.platform !== "win32") {
      expect(fs.statSync(dest).mode & 0o777).toBe(0o600);
    }
    expect(fs.readdirSync(creds).filter((name) => name.endsWith(".new"))).toEqual([]);
    await expect(writePrivateFile(creds, "../escape", "x")).rejects.toThrow(/plain filename/);
  });
});

describe("setup state machine", () => {
  it("bootstraps tools with fakes, persists state, and resumes safely", async () => {
    const dir = freshDir();
    // The fetch returns bytes that do NOT match the pinned hashes: the
    // machine must fail closed at TOOL_BOOTSTRAP (never promote unverified
    // bytes) and persist that phase so rerun resumes instead of duplicating
    // effects. A real python binary path is required for PRECHECK to pass.
    const { execFileSync } = await import("node:child_process");
    let python: string;
    try {
      python = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
    } catch {
      python = process.execPath;
    }
    const fetch = async (): Promise<Buffer> => Buffer.from("wrong-bytes");
    const first = await advanceSetup(dir, { agentId: "lattice", deps: { fetch, python } });
    expect(first.state.phase).toBe("TOOL_BOOTSTRAP");
    expect(loadSetupState(dir)?.phase).toBe("TOOL_BOOTSTRAP");
    expect(first.steps.some((step) => !step.done)).toBe(true);
    // Rerun resumes from persisted state without duplicating effects.
    const second = await advanceSetup(dir, { agentId: "lattice", deps: { fetch, python } });
    expect(second.state.phase).toBe("TOOL_BOOTSTRAP");
  });

  it("fails closed without python and records PRECHECK", async () => {
    const dir = freshDir();
    const result = await advanceSetup(dir, { deps: { python: "/nonexistent/python-xyz", fetch: async () => Buffer.from("x") } });
    expect(result.state.phase).toBe("PRECHECK");
    expect(result.steps.some((step) => !step.done)).toBe(true);
  });
});

describe("scheduler generation", () => {
  it("emits systemd units and windows XML with safe quoting", () => {
    const task = { name: "lattice-index", latticeBin: "/opt/lattice with space/lattice", dataDir: "/tmp/my data/café", intervalMinutes: 60 };
    const { service, timer } = systemdUnits(task);
    expect(service).toContain('"/opt/lattice with space/lattice"');
    expect(service).toContain('"/tmp/my data/café"');
    expect(timer).toContain("OnUnitActiveSec=60min");
    const xml = windowsTaskXml(task);
    expect(xml).not.toContain("&quot;");
    expect(xml).toContain("/opt/lattice with space/lattice");
    expect(xml).toContain("IgnoreNew");
  });

  it("writes definitions idempotently and reports changes", () => {
    const dir = freshDir();
    const task = { name: "lattice-index", latticeBin: process.execPath, dataDir: dir, intervalMinutes: 60 };
    const first = writeSchedulerDefinitions(task, dir);
    expect(first.files).toHaveLength(3);
    expect(first.changed).toBe(true);
    const second = writeSchedulerDefinitions(task, dir);
    expect(second.changed).toBe(false);
  });
});

describe("plow boundary contract", () => {
  it("builds login argv and parses line lists without effects", async () => {
    expect(loginArgv()).toEqual(["login"]);
    expect(loginArgv(["--new-line"])).toEqual(["login", "--new-line"]);
    // Point at a non-script: plowLines fails closed with a typed error.
    const probe = await plowLines({ python: process.execPath, script: path.join(freshDir(), "missing.py") }, 5000);
    expect("error" in probe).toBe(true);
    const minted = await plowMint({ python: process.execPath, script: path.join(freshDir(), "missing.py") }, "ln_x", path.join(freshDir(), "cred"), 5000);
    expect("error" in minted).toBe(true);
  });
});
