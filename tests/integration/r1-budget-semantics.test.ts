import { describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import { admitDurable, claimDurable, recordReceiptDurable, taskBudgetSnapshot } from "../../src/runtime/effects.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { buildSessionExport } from "../../src/telemetry/export.js";
import { openRun, openSession, persistContract } from "../../src/runtime/continuity.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

let dirs: string[] = [];
let openHandles: LatticeDb[] = [];
afterEach(() => {
  for (const handle of openHandles) {
    try {
      handle.close();
    } catch {
      // Best effort.
    }
  }
  openHandles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const GRANT = { calls: 50, tokens: 200_000 };

// R1 budget semantics (D-R1-02): maxCalls/maxTokens are MODEL calls/tokens.
// Tool dispatches never consume modelCalls/modelTokens, but every dispatch
// stays an identified, counted attempt visible to telemetry/export.
describe("r1 tool dispatches do not consume the cognitive budget", () => {
  it("RED: tool attempt leaves model settled/reserved untouched and is counted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1budget-"));
    dirs.push(dir);
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const contract = createContract({
      taskId: "task-1",
      rootId: "root-1",
      objective: "Read the file",
      scope: ["workspace"],
      acceptanceCriteria: ["file contents observed"],
      obligations: ["preserve baseline"],
      grants: [
        { subject: "agent", operations: ["search", "read", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: [],
      realm: "local-trusted",
      allowedProvider: null,
      allowedModel: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "r1",
    });
    persistContract(opened.raw, contract);
    const { sessionId } = openSession(opened.raw, contract.rootId);
    openRun(opened.raw, { sessionId, rootId: contract.rootId, taskId: contract.taskId, manifest: { workspace: "workspace" } });
    const before = taskBudgetSnapshot(opened.raw, "task-1", GRANT);
    const admitted = admitDurable(
      opened.raw, contract,
      { taskId: "task-1", operation: "read", target: "workspace/a.ts", actionKey: "r1-tool", authorityRevision: 1, maxCalls: 0, maxTokens: 0, argsJson: "{}" },
      GRANT, 1,
    );
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    expect(claimDurable(opened.raw, admitted.attemptId, 1, 1, { contract })).toEqual({ claimed: true });
    recordReceiptDurable(opened.raw, {
      attemptId: admitted.attemptId, outcome: "confirmed", summary: "read ok",
      detailJson: "{}", settledCalls: 0, settledTokens: 0,
    });
    // Cognitive budget untouched...
    const after = taskBudgetSnapshot(opened.raw, "task-1", GRANT);
    expect(after.settled).toEqual(before.settled);
    expect(after.reserved).toEqual(before.reserved);
    // ...but the dispatch is a real, counted attempt in the ledger.
    const attempts = opened.raw.prepare("SELECT COUNT(*) AS n FROM attempts WHERE intent_id = ?").get(admitted.intentId) as { n: number };
    expect(attempts.n).toBe(1);
    const intents = opened.raw.prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = 'task-1' AND operation = 'read'").get() as { n: number };
    expect(intents.n).toBe(1);
    // ...and the model-only export stays empty (tool attempts are not
    // model usage and must never be mistaken for it).
    const exported = buildSessionExport(opened.raw, sessionId, "0.0.0");
    expect(exported.lines).toHaveLength(0);
    expect(exported.complete.recordCount).toBe(0);
  });

  it("an explicit tool dispatch cap denies without dispatch when reached", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1cap-"));
    dirs.push(dir);
    const workspace = path.join(dir, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "a.ts"), "x\n");
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const { FakeProvider } = await import("../../src/providers/fake.js");
    const { runTaskLoop } = await import("../../src/runtime/loop.js");
    const { buildToolset } = await import("../../src/tools/registry.js");
    const { ProcessSupervisor } = await import("../../src/tools/process.js");
    const provider = new FakeProvider([
      { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"x\"}" }] },
      { text: "stuck" },
    ]);
    const contract = createContract({
      taskId: "task-1", rootId: "root-1", objective: "Find x", scope: ["workspace"],
      acceptanceCriteria: ["x observed"], obligations: ["preserve baseline"],
      grants: [
        { subject: "agent", operations: ["search", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: [], realm: "local-trusted", allowedProvider: null, allowedModel: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion", origin: "r1",
    });
    const supervisor = new ProcessSupervisor(workspace);
    const stop = await runTaskLoop({
      db: opened.raw, provider, model: "fake-m", contract,
      sessionId: "s1", runId: "r1",
      taskSurface: {
        objective: "Find x", acceptanceCriteria: ["x observed"], grants: ["search under workspace"],
        prohibitions: [], obligations: ["preserve baseline"], unknowns: [], humanDecisions: [], versions: [], lastError: null,
      },
      tools: buildToolset({ supervisor }),
      toolContext: { workspaceRoot: workspace, realm: "local-trusted", timeoutMs: 5000 },
      ownerGeneration: 1, grantedCalls: 50, grantedTokens: 200000, maxIterations: 4,
      maxToolDispatches: 0,
    });
    expect(stop.toolDispatches).toBe(0);
    // One model call admitted (denial of the tool surfaces as evidence, the
    // loop then stalls to ASK on the second programmed step).
    expect(provider.requests.length).toBe(2);
    const toolAttempts = opened.raw.prepare(
      "SELECT COUNT(*) AS n FROM attempts WHERE intent_id IN (SELECT intent_id FROM intents WHERE operation = 'search')",
    ).get() as { n: number };
    expect(toolAttempts.n).toBe(0);
    await supervisor.close();
  });

  it("model.invoke still consumes exactly one call plus input+output tokens", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1budget-m-"));
    dirs.push(dir);
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const contract = createContract({
      taskId: "task-1",
      rootId: "root-1",
      objective: "Think",
      scope: ["workspace"],
      acceptanceCriteria: ["ok"],
      obligations: ["preserve baseline"],
      grants: [
        { subject: "agent", operations: ["model.invoke"], targets: [], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: [],
      realm: "local-trusted",
      allowedProvider: null,
      allowedModel: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "r1",
    });
    const admitted = admitDurable(
      opened.raw, contract,
      { taskId: "task-1", operation: "model.invoke", target: "fake/m", actionKey: "r1-model", authorityRevision: 1, maxCalls: 1, maxTokens: 1000, argsJson: "{}" },
      GRANT, 1,
    );
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    expect(claimDurable(opened.raw, admitted.attemptId, 1, 1, { contract })).toEqual({ claimed: true });
    recordReceiptDurable(opened.raw, {
      attemptId: admitted.attemptId, outcome: "confirmed", summary: "responded",
      detailJson: "{}", settledCalls: 1, settledTokens: 150,
    });
    expect(taskBudgetSnapshot(opened.raw, "task-1", GRANT).settled).toEqual({ calls: 1, tokens: 150 });
  });
});
