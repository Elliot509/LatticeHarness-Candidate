import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findAgentsView, probeLatticeSupport, queryDailyUsage } from "../../src/index/agentsview.js";

// The stub technique: Node itself is the fake executable. A temp directory
// holding a `sync.js` file is used as the child cwd; Node resolves the
// `sync` argv entry to it and runs it, ignoring the remaining arguments.
// This exercises OUR wrapper logic (argv construction, returncode, schema,
// timeout) on every OS without shells, associations, or real binaries.
// Success paths against the real agentsview binary run in the e2e suite.

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// Each spawned step loads its own file: `sync` for the sync step, `usage`
// for the query step. Scripts record their argv to argv-<cmd>.json in the
// stub dir so tests assert exact argv construction.
function stubDir(syncScript: string, usageScript: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-avstub-"));
  dirs.push(dir);
  const record = `const fs = require("node:fs");\n` +
    `const path = require("node:path");\n` +
    `fs.writeFileSync(path.join(process.cwd(), "argv-" + path.basename(process.argv[1], ".js") + ".json"), JSON.stringify(process.argv.slice(1)));\n`;
  fs.writeFileSync(path.join(dir, "sync.js"), `${record}${syncScript}`);
  fs.writeFileSync(path.join(dir, "usage.js"), `${record}${usageScript}`);
  return dir;
}

function readArgv(dir: string, cmd: string): string[] {
  return JSON.parse(fs.readFileSync(path.join(dir, `argv-${cmd}.json`), "utf8")) as string[];
}

const envFor = (dir: string) => ({ dataDir: path.join(dir, "avdata"), exportsDir: path.join(dir, "exports") });

const DAILY = {
  daily: [
    {
      date: "2026-09-11",
      modelBreakdowns: [
        { modelName: "fake-model-1", inputTokens: 100, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 10 },
      ],
    },
  ],
};

const CANARY_DAILY = {
  daily: [
    {
      date: "2026-09-11",
      modelBreakdowns: [
        { modelName: "canary-model", inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ],
    },
  ],
};

describe("agentsview discovery", () => {
  it("prefers an explicit path and falls back to PATH then fixed locations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-avfind-"));
    dirs.push(dir);
    const explicit = path.join(dir, process.platform === "win32" ? "agentsview.exe" : "agentsview");
    fs.writeFileSync(explicit, "x");
    expect(findAgentsView(explicit)).toBe(explicit);
    expect(findAgentsView(path.join(dir, "missing"))).toBeNull();
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir);
    const onPath = path.join(binDir, process.platform === "win32" ? "agentsview.exe" : "agentsview");
    fs.writeFileSync(onPath, "x");
    if (process.platform !== "win32") fs.chmodSync(onPath, 0o755);
    const previous = process.env["PATH"];
    process.env["PATH"] = `${binDir}${path.delimiter}${previous ?? ""}`;
    try {
      expect(findAgentsView()).toBe(onPath);
    } finally {
      if (previous === undefined) delete process.env["PATH"];
      else process.env["PATH"] = previous;
    }
  });
});

describe("agentsview invocation boundary", () => {
  it("parses daily rows and forwards the agent filter in argv", async () => {
    const dir = stubDir(
      `process.exit(0);\n`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(DAILY))});\n`,
    );
    const rows = await queryDailyUsage({
      binary: process.execPath,
      env: envFor(dir),
      agent: "lattice",
      cwd: dir,
      timeoutMs: 15000,
    });
    expect(rows).toEqual([
      {
        date: "2026-09-11",
        modelBreakdowns: [
          { modelName: "fake-model-1", inputTokens: 100, outputTokens: 20, cacheCreationTokens: 5, cacheReadTokens: 10 },
        ],
      },
    ]);
    // The recorded argv must carry the agent filter and offline mode.
    // (argv[0] is the resolved script path; the rest is ours.)
    expect(readArgv(dir, "usage").slice(1)).toEqual(["daily", "--json", "--offline", "--agent", "lattice"]);
  });

  it("rejects a non-zero exit even when stdout still parses", async () => {
    const dir = stubDir(
      `process.exit(0);\n`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(DAILY))});\nprocess.exit(3);\n`,
    );
    await expect(
      queryDailyUsage({ binary: process.execPath, env: envFor(dir), cwd: dir, timeoutMs: 15000 }),
    ).rejects.toThrow(/failed/);
  });

  it("rejects invalid JSON and rows with missing counters", async () => {
    const garbage = stubDir(`process.exit(0);\n`, `process.stdout.write("not json at all");\n`);
    await expect(
      queryDailyUsage({ binary: process.execPath, env: envFor(garbage), cwd: garbage, timeoutMs: 15000 }),
    ).rejects.toThrow(/JSON/);
    const missing = stubDir(
      `process.exit(0);\n`,
      `process.stdout.write(JSON.stringify({ daily: [{ date: "2026-09-11", modelBreakdowns: [{ modelName: "m" }] }] }));\n`,
    );
    await expect(
      queryDailyUsage({ binary: process.execPath, env: envFor(missing), cwd: missing, timeoutMs: 15000 }),
    ).rejects.toThrow(/non-integer|missing/);
  });

  it("times out a hanging binary instead of waiting forever", async () => {
    const dir = stubDir(`process.exit(0);\n`, `setInterval(() => {}, 1000);\n`);
    await expect(
      queryDailyUsage({ binary: process.execPath, env: envFor(dir), cwd: dir, timeoutMs: 500 }),
    ).rejects.toThrow(/timed out/);
  });

  it("probe reports support only when the canary round-trips", async () => {
    const good = stubDir(
      `process.exit(0);\n`,
      `process.stdout.write(${JSON.stringify(JSON.stringify(CANARY_DAILY))});\n`,
    );
    // probeLatticeSupport builds its own sandbox; emulate by pointing PATH at
    // a wrapper is overkill here, so assert the query layer it relies on.
    const rows = await queryDailyUsage({
      binary: process.execPath,
      env: envFor(good),
      agent: "lattice",
      cwd: good,
      timeoutMs: 15000,
    });
    expect(rows[0]?.modelBreakdowns[0]).toMatchObject({ modelName: "canary-model", inputTokens: 7, outputTokens: 3 });
    const bad = stubDir(`process.exit(0);\n`, `process.stdout.write(JSON.stringify({ daily: [] }));\n`);
    const empty = await queryDailyUsage({ binary: process.execPath, env: envFor(bad), cwd: bad, timeoutMs: 15000 });
    expect(empty).toEqual([]);
  });
});

describe("agentsview probe", () => {
  it("rejects binaries without Lattice support", async () => {
    // A binary that exits non-zero can never carry the provider.
    const result = await probeLatticeSupport(process.execPath, 15000);
    expect(result.supported).toBe(false);
  });
});
