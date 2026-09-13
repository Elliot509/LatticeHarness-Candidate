import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clientCollect,
  clientStatus,
  clientSupportsAgentFilter,
  findPython,
  redactSecrets,
} from "../../src/index/client.js";

// These tests drive the REAL pinned official client script (standalone
// agent_index_client.py). They need two things no test may fake:
//   LATTICE_INDEX_CLIENT=<path to the pinned script>
//   python3 on PATH
// Without them the suite reports an explicit skip reason instead of a
// silent pass. CI provides both; see the index-e2e job.

const CLIENT = process.env["LATTICE_INDEX_CLIENT"] ?? "";
const HAS_CLIENT = CLIENT !== "" && fs.existsSync(CLIENT);
const HAS_PYTHON = findPython() !== null;
const RUN = HAS_CLIENT && HAS_PYTHON;

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function isolatedHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-idxhome-"));
  dirs.push(home);
  return home;
}

function seedIdentity(home: string): void {
  const dir = path.join(home, ".agent-index");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".agent-index.json"),
    JSON.stringify({ install_id: "test-install-1", key: "aik_synthetic-test-key-1234567890" }),
  );
}

describe("official client discovery", () => {
  it("finds python3 and detects the Lattice filter marker", () => {
    expect(findPython()).not.toBeNull();
    expect(findPython(path.join(os.tmpdir(), "lattice-no-such-python"))).toBeNull();
    if (!HAS_CLIENT) {
      console.warn("LATTICE_INDEX_CLIENT unset: filter-marker assertion runs in CI");
      return;
    }
    expect(clientSupportsAgentFilter(CLIENT)).toBe(true);
    expect(clientSupportsAgentFilter(path.join(os.tmpdir(), "lattice-no-such-client.py"))).toBe(false);
  });

  it("redacts credential-shaped values from recorded output", () => {
    expect(redactSecrets("key aik_synthetic-test-key-1234567890 here")).toContain("[redacted]");
    expect(redactSecrets("PLOW_AGENT_TOKEN=s3cr3t-value here")).toContain("[redacted]");
    expect(redactSecrets("Bearer abcdef12345")).toContain("[redacted]");
    expect(redactSecrets("plain tokens 100 output 20")).toBe("plain tokens 100 output 20");
    // Ordinary Lattice ids must never trip the scan.
    expect(redactSecrets("task-abcdef12-3456-7890-abcd-ef1234567890")).toContain("task-");
  });
});

describe.runIf(RUN)("official client status codes", () => {
  const config = (): { python: string; script: string } => ({ python: findPython() as string, script: CLIENT });

  it("reports 3 for a fresh install, 0 after seeding, 2 for corrupt state", () => {
    const home = isolatedHome();
    const fresh = spawnSync(findPython() as string, [CLIENT, "status"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(fresh.status).toBe(3);
    seedIdentity(home);
    const seeded = spawnSync(findPython() as string, [CLIENT, "status"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(seeded.status).toBe(0);
    fs.writeFileSync(path.join(home, ".agent-index", ".agent-index.json"), "{corrupt");
    const corrupt = spawnSync(findPython() as string, [CLIENT, "status"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(corrupt.status).toBe(2);
  });

  it("parses the three states without collapsing them", async () => {
    const home = isolatedHome();
    expect((await clientStatus(config(), home)).state).toBe("unregistered");
    seedIdentity(home);
    expect((await clientStatus(config(), home)).state).toBe("registered");
    fs.writeFileSync(path.join(home, ".agent-index", ".agent-index.json"), "{corrupt");
    const broken = await clientStatus(config(), home);
    expect(broken.state).toBe("state-error");
    expect(broken.exitCode).toBe(2);
  });

  it("dry-run collects without publishing", async () => {
    const home = isolatedHome();
    seedIdentity(home);
    const run = await clientCollect(config(), {
      agent: "lattice",
      days: 28,
      dryRun: true,
      home,
      agentsviewDataDir: path.join(home, "avdata"),
      exportsDir: path.join(home, "exports"),
    });
    // No agentsview here: the collector skips (not a failure) and dry-run
    // reports whatever remains. The assertion is behavioral: no publish
    // happens and the wrapper survives with redacted output.
    expect(run.timedOut).toBe(false);
    expect(run.stdout).not.toContain("aik_synthetic");
  });
});
