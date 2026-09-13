import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import {
  admitDurable,
  claimDurable,
  recordReceiptDurable,
  recordUsageRevision,
} from "../../src/runtime/effects.js";
import { openRun, openSession } from "../../src/runtime/continuity.js";
import { openLatticeDb } from "../../src/storage/db.js";
import {
  backoffMs,
  hasHermesStore,
  loadReporterConfig,
  readCredentialToken,
  reporterPaths,
  reporterTick,
  saveReporterConfig,
} from "../../src/index/reporter.js";
import { findPython } from "../../src/index/client.js";

// Reporter tests are hermetic: the agentsview "binary" is Node itself
// running stub scripts (sync.js/usage.js) in a stub dir passed as spawn
// cwd, and the "official client" is a tiny marker.py driven by a control
// file. These stand in for OS process boundaries the same way FakeProvider
// stands in for a model. The real binary and the real client run in the e2e
// suite, never here.

let dirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();
function saveEnv(key: string): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
}
function clearEnv(key: "HERMES_HOME"): void {
  saveEnv(key);
  process.env[key] = "";
}
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined || value === "") Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-index-"));
  dirs.push(dir);
  return dir;
}

function stubAgentsviewDir(daily: unknown, canaryDaily?: unknown): string {
  // Scripted stand-in for the agentsview binary: sync exits 0, usage prints
  // the canned daily document from control.json. The usage script answers
  // the capability probe (sync.js + usage.js in the stub dir) with the
  // canary document and every later invocation with `daily`: the stub routes
  // on STUB_CANARY_ONLY, which the reporter probe sets in its own child env.
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, "sync.js"), "process.exit(0);\n");
  fs.writeFileSync(
    path.join(dir, "usage.js"),
    [
      `const fs = require("node:fs");`,
      `const path = require("node:path");`,
      `const control = JSON.parse(fs.readFileSync(path.join(process.cwd(), "control.json"), "utf8"));`,
      `if (control.usageExit !== undefined) { process.exit(control.usageExit); }`,
      `if (process.env["STUB_CANARY_ONLY"] === "1") { process.stdout.write(JSON.stringify(control.canary ?? { daily: [] })); }`,
      `else { process.stdout.write(JSON.stringify(control.daily ?? { daily: [] })); }`,
      ``,
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "control.json"), JSON.stringify({ daily, canary: canaryDaily ?? daily }));
  return dir;
}

function markerClientDir(): { script: string; control: string; calls: string } {
  const dir = freshDir();
  const script = path.join(dir, "marker_client.py");
  const control = path.join(dir, "control.json");
  const calls = path.join(dir, "calls.log");
  fs.writeFileSync(
    script,
    [
      "import json, os, sys",
      `CONTROL = ${JSON.stringify(control)}`,
      `CALLS = ${JSON.stringify(calls)}`,
      "argv = sys.argv[1:]",
      "# The Lattice agent filter is mandatory on collect runs; fail loudly",
      "# without it so no test can pass while exercising unfiltered totals.",
      "if argv[:1] != ['status']:",
      "    assert 'AGENT_INDEX_AGENTS' in os.environ, 'AGENT_INDEX_AGENTS missing'",
      "    assert os.environ['AGENT_INDEX_AGENTS'] == 'lattice', os.environ.get('AGENT_INDEX_AGENTS')",
      "open(CALLS, 'a').write(' '.join(argv) + '\\n')",
      "try:",
      "    control = json.load(open(CONTROL))",
      "except Exception:",
      "    control = {}",
      "if argv[:1] == ['status']:",
      "    sys.exit(int(control.get('status', 0)))",
      "if control.get('collect') == 'sleep':",
      "    import time",
      "    time.sleep(30)",
      "sys.exit(int(control.get('collect', 0)))",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(control, JSON.stringify({ status: 0, collect: 0 }));
  return { script, control, calls };
}

function seedLedger(dataDir: string, opts?: { unknown?: boolean }): { sessionId: string } {
  const db = openLatticeDb(dataDir);
  try {
    const contract = createContract({
      taskId: "task-idx",
      rootId: "root-idx",
      objective: "Indexed work",
      scope: [dataDir],
      acceptanceCriteria: ["done"],
      obligations: ["preserve baseline"],
      grants: [
        { subject: "agent", operations: ["model.invoke"], targets: [dataDir], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: [],
      realm: "local-trusted",
      allowedProvider: "fake",
      allowedModel: "fake-model-1",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "test",
    });
    db.raw.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      contract.taskId,
      contract.rootId,
      contract.revision,
      JSON.stringify(contract),
      new Date().toISOString(),
    );
    const { sessionId } = openSession(db.raw, contract.rootId);
    openRun(db.raw, { sessionId, rootId: contract.rootId, taskId: contract.taskId, manifest: { provider: "fake", model: "fake-model-1" } });
    const admitted = admitDurable(
      db.raw,
      contract,
      {
        taskId: contract.taskId,
        operation: "model.invoke",
        target: "fake/m",
        actionKey: "model-1",
        authorityRevision: 1,
        maxCalls: 1,
        maxTokens: 4000,
        argsJson: "{}",
        requestId: "req-1",
      },
      { calls: 50, tokens: 200000 },
      1,
    );
    if (!admitted.admitted) throw new Error("admission failed");
    if (!claimDurable(db.raw, admitted.attemptId, 1, 1).claimed) throw new Error("claim failed");
    recordReceiptDurable(db.raw, {
      attemptId: admitted.attemptId,
      outcome: "confirmed",
      summary: "responded",
      detailJson: JSON.stringify({ usageFinal: true }),
      settledCalls: 1,
      settledTokens: 120,
    });
    const doc = {
      schemaVersion: 1,
      sessionId,
      runId: "run-1",
      taskId: contract.taskId,
      rootId: contract.rootId,
      requestId: "req-1",
      attemptId: admitted.attemptId,
      parentAttemptId: null,
      intentId: admitted.intentId,
      executorGeneration: 1,
      provider: "fake",
      modelRequested: "canary-model",
      modelResolved: "canary-model",
      adapterRevision: "fake-1",
      usageRevision: 0,
      usageFinal: true,
      purpose: "primary",
      status: "completed",
      admittedAt: "2026-09-11T10:00:00Z",
      dispatchedAt: "2026-09-11T10:00:01Z",
      firstTokenAt: null,
      finishedAt: "2026-09-11T10:00:02Z",
      recordedAt: "2026-09-11T10:00:03Z",
      clockQuality: "wall",
      durationMs: 1000,
      providerRequestId: null,
      error: null,
      inputTotal: { value: 7, quality: "observed", source: "s" },
      inputNew: { value: 7, quality: "observed", source: "s" },
      cacheRead: { value: 0, quality: "observed", source: "s" },
      cacheWrite: { value: 0, quality: "observed", source: "s" },
      outputTotal: opts?.unknown === true ? { value: null, quality: "unknown", source: "s" } : { value: 3, quality: "observed", source: "s" },
      reasoningSubset: null,
    };
    recordUsageRevision(db.raw, admitted.attemptId, JSON.stringify(doc));
    return { sessionId };
  } finally {
    db.close();
  }
}

const STUB_DAILY = {
  daily: [
    {
      date: "2026-09-11",
      modelBreakdowns: [
        { modelName: "canary-model", inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      ],
    },
  ],
};

function configure(dataDir: string, overrides?: Partial<Parameters<typeof saveReporterConfig>[1]>): void {
  const paths = reporterPaths(dataDir);
  saveReporterConfig(paths, {
    enabled: true,
    agentId: "lattice",
    days: 28,
    ...overrides,
  });
}

describe("reporter basics", () => {
  it("reports disabled/unconfigured without spawning anything", async () => {
    const root = freshDir();
    const dataDir = path.join(root, "data");
    expect(await reporterTick(dataDir)).toMatchObject({ status: "unavailable" });
    configure(dataDir, { enabled: false, agentsviewPath: "/nonexistent" });
    expect(await reporterTick(dataDir)).toMatchObject({ status: "disabled" });
    expect(loadReporterConfig(reporterPaths(dataDir))).toMatchObject({ enabled: false });
  });

  it("computes bounded backoff and honors it between ticks", () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(60_000);
    expect(backoffMs(2)).toBe(120_000);
    // 1m, 2m, 4m ... capped at the 32x step (1.92m); the clamp index and the
    // 3.6m cap mean the table saturates at 1.92m, never at the raw cap.
    expect(backoffMs(6)).toBe(1_920_000);
    expect(backoffMs(99)).toBe(1_920_000);
  });

  it("serializes ticks with a lock file and takes over stale locks", async () => {
    const root = freshDir();
    const dataDir = path.join(root, "data");
    const avStub = stubAgentsviewDir(STUB_DAILY, { daily: [{ date: "2026-09-11", modelBreakdowns: [{ modelName: "canary-model", inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 }] }] });
    const marker = markerClientDir();
    const python = findPython();
    if (python === null) throw new Error("python3 required for index reporter tests");
    configure(dataDir, { agentsviewPath: process.execPath, clientScript: marker.script, pythonPath: python });
    const paths = reporterPaths(dataDir);
    fs.mkdirSync(paths.indexDir, { recursive: true });
    fs.writeFileSync(path.join(paths.indexDir, "tick.lock"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    expect(await reporterTick(dataDir, { spawnCwd: avStub })).toMatchObject({ status: "already-running" });
    fs.writeFileSync(
      path.join(paths.indexDir, "tick.lock"),
      JSON.stringify({ pid: 999999999, startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() }),
    );
    // Stale lock (dead pid, old stamp) is taken over: the tick proceeds past
    // locking (here it reaches the empty ledger and reports zero days).
    const result = await reporterTick(dataDir, { spawnCwd: avStub });
    expect(result.status).not.toBe("already-running");
  });
});

describe("reporter hermes gate", () => {
  it("refuses when a Hermes usage store with rows exists", async () => {
    const root = freshDir();
    saveEnv("HERMES_HOME");
    const hermesHome = path.join(root, "hermes-home");
    fs.mkdirSync(hermesHome, { recursive: true });
    const sqlite = new DatabaseSync(path.join(hermesHome, "state.db"));
    try {
      sqlite.exec(
        "CREATE TABLE session_model_usage (session_id TEXT, model TEXT, input_tokens INT, output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, first_seen REAL, last_seen REAL)",
      );
      sqlite.exec("INSERT INTO session_model_usage VALUES ('s','m',1,2,0,0,0,0)");
    } finally {
      sqlite.close();
    }
    process.env["HERMES_HOME"] = hermesHome;
    const probe = hasHermesStore();
    expect(probe.present).toBe(true);
    expect(probe.where.endsWith("state.db")).toBe(true);
    const dataDir = path.join(root, "data");
    configure(dataDir, { agentsviewPath: "/nonexistent" });
    const result = await reporterTick(dataDir);
    expect(result.status).toBe("unavailable");
    expect(result.detail).toContain("Hermes");
  });

  it("ignores Hermes homes without a usage table", () => {
    const root = freshDir();
    saveEnv("HERMES_HOME");
    const hermesHome = path.join(root, "empty-home");
    fs.mkdirSync(hermesHome, { recursive: true });
    const sqlite = new DatabaseSync(path.join(hermesHome, "state.db"));
    try {
      sqlite.exec("CREATE TABLE other (id INT)");
    } finally {
      sqlite.close();
    }
    process.env["HERMES_HOME"] = hermesHome;
    expect(hasHermesStore()).toMatchObject({ present: false });
  });
});

describe("reporter tick with stubs", () => {
  it("reports a matching stub index and records success without secrets", async () => {
    const root = freshDir();
    clearEnv("HERMES_HOME");
    const dataDir = path.join(root, "data");
    seedLedger(dataDir);
    const avStub = stubAgentsviewDir(STUB_DAILY, { daily: [{ date: "2026-09-11", modelBreakdowns: [{ modelName: "canary-model", inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 }] }] });
    const marker = markerClientDir();
    const python = findPython();
    if (python === null) throw new Error("python3 required for index reporter tests");
    const credFile = path.join(root, "cred.env");
    fs.writeFileSync(credFile, "PLOW_API_BASE=https://example.invalid\nPLOW_AGENT_TOKEN=synthetic-token-abcdef123\n# plow-agent-uid: test-uid\n");
    configure(dataDir, { agentsviewPath: process.execPath, clientScript: marker.script, pythonPath: python, credentialFile: credFile });
    const result = await reporterTick(dataDir, { spawnCwd: avStub });
    expect(result).toMatchObject({ status: "reported", reportedDays: 1, reportedTokens: 10 });
    const paths = reporterPaths(dataDir);
    const stateText = fs.readFileSync(paths.stateFile, "utf8");
    expect(stateText).not.toContain("synthetic-token");
    expect(stateText).toContain("lastSuccessTokens");
    expect(result.detail).not.toContain("synthetic-token");
    const calls = fs.readFileSync(marker.calls, "utf8");
    expect(calls).toContain("--agent");
    // Export file exists with the real ledger content.
    const exports = fs.readdirSync(paths.exportsDir);
    expect(exports).toHaveLength(1);
  });

  it("keeps incomplete windows pending without invoking the client", async () => {
    const root = freshDir();
    clearEnv("HERMES_HOME");
    const dataDir = path.join(root, "data");
    seedLedger(dataDir, { unknown: true });
    const avStub = stubAgentsviewDir(STUB_DAILY, { daily: [{ date: "2026-09-11", modelBreakdowns: [{ modelName: "canary-model", inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 }] }] });
    const marker = markerClientDir();
    const python = findPython();
    if (python === null) throw new Error("python3 required for index reporter tests");
    configure(dataDir, { agentsviewPath: process.execPath, clientScript: marker.script, pythonPath: python });
    const result = await reporterTick(dataDir, { spawnCwd: avStub });
    expect(result.status).toBe("pending");
    expect(result.detail).toContain("incomplete");
    expect(fs.existsSync(marker.calls)).toBe(false);
  });

  it("backs off after a failing client and stays pending", async () => {
    const root = freshDir();
    clearEnv("HERMES_HOME");
    const dataDir = path.join(root, "data");
    seedLedger(dataDir);
    const avStub = stubAgentsviewDir(STUB_DAILY, { daily: [{ date: "2026-09-11", modelBreakdowns: [{ modelName: "canary-model", inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 }] }] });
    const marker = markerClientDir();
    fs.writeFileSync(path.join(path.dirname(marker.control), "control.json"), JSON.stringify({ status: 0, collect: 1 }));
    const python = findPython();
    if (python === null) throw new Error("python3 required for index reporter tests");
    configure(dataDir, { agentsviewPath: process.execPath, clientScript: marker.script, pythonPath: python });
    const first = await reporterTick(dataDir, { spawnCwd: avStub });
    expect(first.status).toBe("pending");
    const callsAfterFirst = fs.existsSync(marker.calls) ? fs.readFileSync(marker.calls, "utf8") : "";
    expect(callsAfterFirst).toContain("--agent");
    // Immediate retry backs off without spawning the client again.
    const second = await reporterTick(dataDir, { spawnCwd: avStub });
    expect(second.status).toBe("pending");
    expect(second.detail).toContain("backing off");
    expect(fs.readFileSync(marker.calls, "utf8")).toBe(callsAfterFirst);
  });

  it("never registers or touches install identity on unregistered installs", async () => {
    const root = freshDir();
    clearEnv("HERMES_HOME");
    const dataDir = path.join(root, "data");
    seedLedger(dataDir);
    const avStub = stubAgentsviewDir(STUB_DAILY, { daily: [{ date: "2026-09-11", modelBreakdowns: [{ modelName: "canary-model", inputTokens: 7, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 }] }] });
    const marker = markerClientDir();
    fs.writeFileSync(path.join(path.dirname(marker.control), "control.json"), JSON.stringify({ status: 3, collect: 0 }));
    const python = findPython();
    if (python === null) throw new Error("python3 required for index reporter tests");
    configure(dataDir, { agentsviewPath: process.execPath, clientScript: marker.script, pythonPath: python });
    const result = await reporterTick(dataDir, { spawnCwd: avStub });
    expect(result.status).toBe("pending");
    expect(result.detail).toContain("unregistered");
    // The stub records every invocation: status was asked, collect never ran,
    // and no register-shaped argv ever appears.
    const calls = fs.readFileSync(marker.calls, "utf8");
    expect(calls).toContain("status");
    expect(calls).not.toContain("--dry-run");
    expect(calls).not.toContain("register");
  });
});

describe("credential handling", () => {
  it("parses the token as data and never logs it", async () => {
    const root = freshDir();
    const credFile = path.join(root, "cred.env");
    fs.writeFileSync(credFile, 'PLOW_API_BASE=https://example.invalid\nPLOW_AGENT_TOKEN="synthetic-token-xyz"\n');
    expect(readCredentialToken(credFile)).toBe("synthetic-token-xyz");
    expect(readCredentialToken(path.join(root, "missing.env"))).toBeNull();
    fs.writeFileSync(credFile, "PLOW_API_BASE=https://example.invalid\n");
    expect(readCredentialToken(credFile)).toBeNull();
  });
});
