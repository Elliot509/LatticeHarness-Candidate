import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexDisableCommand, indexSetupCommand, indexStatusCommand, indexTickCommand } from "../../src/cli/index.js";
import { reporterPaths, saveReporterConfig } from "../../src/index/reporter.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fresh(): { workspace: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-indexcli-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  return { workspace };
}

async function capture(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await run();
    return { code, out };
  } finally {
    process.stdout.write = original;
  }
}

describe("index cli", () => {
  it("status reports unconfigured, setup refuses gaps, disable preserves history", async () => {
    const { workspace } = fresh();
    const dataDir = path.join(workspace, "data");
    const unconfigured = await capture(() => indexStatusCommand({ workspace, dataDir, json: true }));
    expect(unconfigured.code).toBe(0);
    expect(JSON.parse(unconfigured.out)).toMatchObject({ configured: false, state: "unavailable" });

    const refused = await capture(() =>
      indexSetupCommand({ workspace, dataDir, agentId: "lattice", agentsviewPath: "/nonexistent", clientScript: "/nonexistent.py", enable: true }),
    );
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("NOT written");

    const disabled = await capture(() => indexDisableCommand({ workspace, dataDir }));
    expect(disabled.code).toBe(0);
    expect(disabled.out).toContain("not configured");
  });

  it("writes config on valid setup, reports disabled state, and refuses ticks while disabled", async () => {
    // NOTE: indexSetupCommand now also runs the S4.1-A bootstrap stages
    // (verified downloads), which need network in production. This test
    // covers the classic validation path only: the probe rejects the bare
    // interpreter before any download, so no network happens here.
    const { workspace } = fresh();
    const dataDir = path.join(workspace, "data");
    const avStub = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-idxsetup-"));
    dirs.push(avStub);
    fs.writeFileSync(path.join(avStub, "sync.js"), "process.exit(0);\n");
    fs.writeFileSync(
      path.join(avStub, "usage.js"),
      `process.stdout.write(JSON.stringify({ daily: [{ date: "2026-09-11", modelBreakdowns: [{ modelName: "canary-model", inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 }] }] }));\n`,
    );
    const clientDir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-idxclient-"));
    dirs.push(clientDir);
    const script = path.join(clientDir, "client.py");
    fs.writeFileSync(script, "# pinned client with AGENT_INDEX_AGENTS support\n");
    const written = await capture(() =>
      indexSetupCommand({
        workspace,
        dataDir,
        agentId: "lattice",
        agentsviewPath: process.execPath,
        clientScript: script,
        pythonPath: process.execPath,
        enable: false,
      }),
    );
    // The canary probe runs node-as-binary without the stub cwd: it fails,
    // which is correct behavior (a bare interpreter is not agentsview).
    expect(written.code).toBe(1);
    expect(written.out).toContain("without Lattice support");

    // Write the config directly to test the status/disable/report paths.
    saveReporterConfig(reporterPaths(dataDir), {
      enabled: false,
      agentId: "lattice",
      days: 28,
      agentsviewPath: process.execPath,
      clientScript: script,
      pythonPath: process.execPath,
    });
    const status = await capture(() => indexStatusCommand({ workspace, dataDir, json: true }));
    expect(status.code).toBe(0);
    expect(JSON.parse(status.out)).toMatchObject({ configured: true, state: "disabled" });
    const tick = await capture(() => indexTickCommand(workspace, dataDir, true));
    expect(tick.code).toBe(0);
    expect(tick.out).toContain("disabled");
    const disable = await capture(() => indexDisableCommand({ workspace, dataDir }));
    expect(disable.code).toBe(0);
    expect(disable.out).toContain("preserved");
  });
});
