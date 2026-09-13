import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import {
  admitDurable,
  claimDurable,
  recordReceiptDurable,
  recordUsageRevision,
} from "../../src/runtime/effects.js";
import { openRun, openSession } from "../../src/runtime/continuity.js";
import { armFault, clearFaults } from "../../src/runtime/faults.js";
import { runTaskLoop } from "../../src/runtime/loop.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import {
  assertNoSecrets,
  buildSessionExport,
  canonicalDay,
  parseExportFile,
  serializeExport,
  writeExportFile,
} from "../../src/telemetry/export.js";
import type { AttemptUsage } from "../../src/telemetry/usage.js";
import type { TaskContract } from "../../src/runtime/contract.js";

let dirs: string[] = [];
let openHandles: LatticeDb[] = [];
afterEach(() => {
  clearFaults();
  for (const handle of openHandles) {
    try {
      handle.close();
    } catch {
      // Cleanup is best effort; the assertions already ran.
    }
  }
  openHandles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function track(handle: LatticeDb): LatticeDb {
  openHandles.push(handle);
  return handle;
}

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-export-"));
  dirs.push(dir);
  return dir;
}

function contract(taskId: string, workspace: string): TaskContract {
  return createContract({
    taskId,
    rootId: `root-${taskId}`,
    objective: "Export the ledger",
    scope: [workspace],
    acceptanceCriteria: ["usage accounted"],
    obligations: ["preserve baseline"],
    grants: [
      { subject: "agent", operations: ["search", "model.invoke"], targets: [workspace], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
    ],
    prohibitions: ["publish"],
    realm: "local-trusted",
    allowedProvider: "fake",
    allowedModel: "fake-model-1",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    retentionPolicy: "retain until explicit deletion",
    origin: "test",
  });
}

function persistTask(db: LatticeDb["raw"], taskId: string, workspace: string): { sessionId: string; runId: string } {
  const built = contract(taskId, workspace);
  db.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    built.rootId,
    built.revision,
    JSON.stringify(built),
    new Date().toISOString(),
  );
  const { sessionId } = openSession(db, built.rootId);
  const runId = openRun(db, { sessionId, rootId: built.rootId, taskId, manifest: { packageVersion: "0.0.0" } });
  return { sessionId, runId };
}

function usageDoc(attemptId: string, overrides?: Partial<AttemptUsage>): AttemptUsage {
  return {
    schemaVersion: 1,
    sessionId: "session-x",
    runId: "run-x",
    taskId: "task-x",
    rootId: "root-task-x",
    requestId: "req-x",
    attemptId,
    parentAttemptId: null,
    intentId: "intent-x",
    executorGeneration: 1,
    provider: "fake",
    modelRequested: "fake-model-1",
    modelResolved: "fake-model-1",
    adapterRevision: "fake-1",
    usageRevision: 0,
    usageFinal: true,
    purpose: "primary",
    status: "completed",
    admittedAt: "2026-09-11T10:00:00.000Z",
    dispatchedAt: "2026-09-11T10:00:01.000Z",
    firstTokenAt: null,
    finishedAt: "2026-09-11T10:00:02.000Z",
    recordedAt: "2026-09-11T10:00:03.000Z",
    clockQuality: "wall",
    durationMs: 1000,
    providerRequestId: "fake-req-1",
    error: null,
    inputTotal: { value: 100, quality: "observed", source: "fake/fake-1" },
    inputNew: { value: 100, quality: "observed", source: "fake/fake-1" },
    cacheRead: { value: 0, quality: "observed", source: "fake/fake-1" },
    cacheWrite: { value: 0, quality: "observed", source: "fake/fake-1" },
    outputTotal: { value: 20, quality: "observed", source: "fake/fake-1" },
    reasoningSubset: null,
    ...overrides,
  };
}

function modelAttempt(db: LatticeDb["raw"], taskId: string, key: string): string {
  const admitted = admitDurable(
    db,
    contract(taskId, "ws"),
    {
      taskId,
      operation: "model.invoke",
      target: "fake/m",
      actionKey: key,
      authorityRevision: 1,
      maxCalls: 1,
      maxTokens: 4000,
      argsJson: "{}",
      requestId: `req-${key}`,
    },
    { calls: 50, tokens: 200000 },
    1,
  );
  if (!admitted.admitted) throw new Error("admission failed");
  if (!claimDurable(db, admitted.attemptId, 1, 1).claimed) throw new Error("claim failed");
  recordReceiptDurable(db, {
    attemptId: admitted.attemptId,
    outcome: "confirmed",
    summary: "responded",
    detailJson: JSON.stringify({ usageFinal: true }),
    settledCalls: 1,
    settledTokens: 120,
  });
  return admitted.attemptId;
}

describe("export v1 shape", () => {
  it("writes session, attempt and terminator lines with normative fields only", () => {
    const root = freshDir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const { sessionId } = persistTask(opened.raw, "task-e1", path.join(root, "ws"));
    const attemptId = modelAttempt(opened.raw, "task-e1", "m1");
    recordUsageRevision(opened.raw, attemptId, JSON.stringify(usageDoc(attemptId, { sessionId, taskId: "task-e1" })));
    const exported = buildSessionExport(opened.raw, sessionId, "0.0.0");
    expect(exported.header).toMatchObject({
      schemaVersion: 1,
      recordType: "session",
      sessionId,
      producer: "Lattice",
      packageVersion: "0.0.0",
      timezone: "UTC",
    });
    expect(exported.header).not.toHaveProperty("prompt");
    expect(exported.lines).toHaveLength(1);
    expect(exported.lines[0]?.recordType).toBe("attempt_usage");
    expect(exported.lines[0]?.usage.attemptId).toBe(attemptId);
    expect(exported.complete).toMatchObject({ recordType: "export_complete", sessionId, recordCount: 1 });
    const text = serializeExport(exported).join("\n");
    expect(text).not.toContain("price.txt");
    const parsed = parseExportFile(text);
    expect(parsed.attempts.map((usage) => usage.attemptId)).toEqual([attemptId]);
    expect(parsed.header.usageCoverage.attempts).toBe(1);
  });

  it("keeps unknown quantities as unknown and counts the coverage gap", () => {
    const root = freshDir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const { sessionId } = persistTask(opened.raw, "task-e2", path.join(root, "ws"));
    // Attempt without any usage document: unknown, never zero.
    modelAttempt(opened.raw, "task-e2", "m1");
    const exported = buildSessionExport(opened.raw, sessionId, "0.0.0");
    expect(exported.lines).toHaveLength(1);
    expect(exported.lines[0]?.usage.inputTotal).toEqual({ value: null, quality: "unknown", source: "lattice-export" });
    expect(exported.header.usageCoverage.unknown).toBe(1);
    expect(exported.header.usageCoverage.knownInputTotal).toBe(0);
  });

  it("revises the same attempt on late usage instead of duplicating it", () => {
    const root = freshDir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const { sessionId } = persistTask(opened.raw, "task-e3", path.join(root, "ws"));
    const attemptId = modelAttempt(opened.raw, "task-e3", "m1");
    recordUsageRevision(opened.raw, attemptId, JSON.stringify(usageDoc(attemptId, { sessionId, taskId: "task-e3", outputTotal: { value: 20, quality: "observed", source: "s" } })));
    const first = parseExportFile(serializeExport(buildSessionExport(opened.raw, sessionId, "0.0.0")).join("\n"));
    expect(first.attempts[0]?.usageRevision).toBe(1);
    recordUsageRevision(opened.raw, attemptId, JSON.stringify(usageDoc(attemptId, { sessionId, taskId: "task-e3", outputTotal: { value: 25, quality: "observed", source: "s" } })));
    const second = parseExportFile(serializeExport(buildSessionExport(opened.raw, sessionId, "0.0.0")).join("\n"));
    expect(second.attempts).toHaveLength(1);
    expect(second.attempts[0]?.attemptId).toBe(attemptId);
    expect(second.attempts[0]?.usageRevision).toBe(2);
    expect(second.attempts[0]?.outputTotal.value).toBe(25);
    // Upsert by identity: parsing both files and merging keeps one row.
    const merged = new Map(second.attempts.map((usage) => [usage.attemptId, usage]));
    for (const usage of first.attempts) merged.set(usage.attemptId, usage.usageRevision > (merged.get(usage.attemptId)?.usageRevision ?? 0) ? usage : (merged.get(usage.attemptId) as AttemptUsage));
    expect(merged.size).toBe(1);
    expect(merged.get(attemptId)?.usageRevision).toBe(2);
  });

  it("attributes the canonical day from finishedAt and leaves unfinished attempts pending", () => {
    expect(canonicalDay(usageDoc("a", { finishedAt: "2026-09-11T23:59:59.000Z" }))).toBe("2026-09-11");
    expect(canonicalDay(usageDoc("b", { finishedAt: "2026-09-12T00:00:01.000Z" }))).toBe("2026-09-12");
    expect(canonicalDay(usageDoc("c", { finishedAt: null, status: "pending" }))).toBeNull();
  });

  it("refuses secrets anywhere in the export", () => {
    const leaky = usageDoc("leak", { error: "auth failed for sk-test-abcdefgh1234" });
    expect(() => assertNoSecrets({} as never, [{ recordType: "attempt_usage", canonicalDay: null, usage: leaky }])).toThrow(/secret/);
    const fieldLeak = { ...usageDoc("leak2"), error: null } as Record<string, unknown>;
    fieldLeak["apiKey"] = "value";
    expect(() =>
      assertNoSecrets({} as never, [{ recordType: "attempt_usage", canonicalDay: null, usage: fieldLeak as unknown as AttemptUsage }]),
    ).toThrow(/credential/);
    const root = freshDir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const { sessionId } = persistTask(opened.raw, "task-e4", path.join(root, "ws"));
    const attemptId = modelAttempt(opened.raw, "task-e4", "m1");
    recordUsageRevision(opened.raw, attemptId, JSON.stringify(usageDoc(attemptId, { sessionId, taskId: "task-e4", error: "bad key sk-live-abcdefgh1234" })));
    expect(() => buildSessionExport(opened.raw, sessionId, "0.0.0")).toThrow(/secret/i);
  });
});

describe("export file safety", () => {
  it("keeps the previous valid export when a mid-write failure hits", () => {
    const root = freshDir();
    const dest = path.join(root, "out dir", "usage.jsonl");
    writeExportFile(dest, ['{"recordType":"session"}', '{"recordType":"export_complete"}']);
    const before = fs.readFileSync(dest, "utf8");
    armFault("export-mid-write");
    try {
      expect(() => writeExportFile(dest, ["a", "b", "c", "d"])).toThrow();
    } finally {
      clearFaults();
    }
    expect(fs.readFileSync(dest, "utf8")).toBe(before);
    const leftovers = fs.readdirSync(path.join(root, "out dir")).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("replaces an existing destination atomically on success", () => {
    const root = freshDir();
    const dest = path.join(root, "usage.jsonl");
    writeExportFile(dest, ["one"]);
    writeExportFile(dest, ["two"]);
    expect(fs.readFileSync(dest, "utf8")).toBe("two\n");
  });

  it("rejects files without a matching terminator", () => {
    expect(() => parseExportFile("")).toThrow(/empty/);
    expect(() => parseExportFile('{"schemaVersion":1,"recordType":"session","producer":"Lattice"}\n')).toThrow(/terminator/);
    expect(() =>
      parseExportFile('{"schemaVersion":1,"recordType":"session","producer":"Lattice","sessionId":"s","ledgerCut":0}\n{"recordType":"attempt_usage","usage":{}}\n'),
    ).toThrow(/terminator/);
    expect(() =>
      parseExportFile(
        '{"schemaVersion":1,"recordType":"session","producer":"Lattice","sessionId":"s","ledgerCut":0}\n{"recordType":"export_complete","sessionId":"s","recordCount":2,"ledgerCut":0}\n',
      ),
    ).toThrow(/counts 2/);
  });
});

describe("loop writes exportable usage", () => {
  it("records every physical model dispatch with session identity", async () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const opened = track(openLatticeDb(path.join(root, "data")));
    const { sessionId, runId } = persistTask(opened.raw, "task-loop", workspace);
    const row = opened.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get("task-loop") as { document: string };
    const built = JSON.parse(row.document) as TaskContract;
    const provider = new FakeProvider([
      { usage: { inputTokens: 50, outputTokens: 10 }, text: "done" },
    ]);
    const stop = await runTaskLoop({
      db: opened.raw,
      provider,
      model: "fake-model-1",
      contract: built,
      sessionId,
      runId,
      taskSurface: {
        objective: "x",
        acceptanceCriteria: ["y"],
        grants: ["none"],
        prohibitions: [],
        obligations: ["preserve baseline"],
        unknowns: [],
        humanDecisions: [],
        versions: [],
        lastError: null,
      },
      tools: [],
      toolContext: { workspaceRoot: workspace, realm: "local-trusted", timeoutMs: 5000 },
      ownerGeneration: 1,
      grantedCalls: 50,
      grantedTokens: 200000,
      maxIterations: 4,
      acceptanceVerifiers: [() => ({ complete: true, reason: "test acceptance" })],
    });
    expect(stop.decision).toBe("STOP");
    const exported = buildSessionExport(opened.raw, sessionId, "0.0.0");
    expect(exported.lines).toHaveLength(1);
    expect(exported.lines[0]?.usage.sessionId).toBe(sessionId);
    expect(exported.lines[0]?.usage.runId).toBe(runId);
    expect(exported.lines[0]?.usage.inputTotal).toEqual({ value: 50, quality: "observed", source: "fake/fake-1" });
    expect(exported.header.usageCoverage.observed).toBe(1);
  });
});
