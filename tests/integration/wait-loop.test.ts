import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import { openRun, openSession } from "../../src/runtime/continuity.js";
import { runTaskLoop, type LoopOptions } from "../../src/runtime/loop.js";
import { FakeProvider } from "../../src/providers/fake.js";
import {
  consumeFiredWait,
  enterWait,
  levelWakeId,
  listActiveWaits,
  notePendingRevision,
  recordWake,
  HandleWaiter,
} from "../../src/runtime/wait.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";

let dirs: string[] = [];
let openHandles: LatticeDb[] = [];
afterEach(() => {
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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-waitloop-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const opened = openLatticeDb(path.join(dir, "data"));
  openHandles.push(opened);
  const contract = createContract({
    taskId: "task-wait-loop",
    rootId: "root-task-wait-loop",
    objective: "Wait without calling the model",
    scope: [workspace],
    acceptanceCriteria: ["process observed"],
    obligations: ["observe the sleeper"],
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
  opened.raw.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    contract.taskId,
    contract.rootId,
    contract.revision,
    JSON.stringify(contract),
    new Date().toISOString(),
  );
  const { sessionId } = openSession(opened.raw, contract.rootId);
  const runId = openRun(opened.raw, { sessionId, rootId: contract.rootId, taskId: contract.taskId, manifest: {} });
  const base: Omit<LoopOptions, "waiter"> = {
    db: opened.raw,
    provider: new FakeProvider([]),
    model: "fake-model-1",
    contract,
    sessionId,
    runId,
    taskSurface: {
      objective: contract.objective,
      acceptanceCriteria: [...contract.acceptanceCriteria],
      grants: ["search under workspace"],
      prohibitions: [...contract.prohibitions],
      obligations: [...contract.obligations],
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
    maxIterations: 6,
  };
  return { db: opened.raw, base, workspace };
}

function modelAttempts(db: LatticeDb["raw"]): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM attempts a JOIN intents i ON i.intent_id = a.intent_id WHERE i.task_id = ? AND i.operation = 'model.invoke'")
    .get("task-wait-loop") as { n: number };
  return row.n;
}

describe("stable WAIT makes zero model calls", () => {
  it("enters a process wait without dispatching anything", async () => {
    const { db, base } = setup();
    const stop = await runTaskLoop({
      ...base,
      waiter: {
        check: () => ({
          wait: {
            kind: "process",
            condition: "sleeper still running",
            source: "process:proc_1",
            observedCursor: "bytes:0",
            obligation: "observe the sleeper",
          },
        }),
      },
    });
    expect(stop.wait).toMatchObject({ kind: "process", condition: "sleeper still running" });
    expect(modelAttempts(db)).toBe(0);
    expect(listActiveWaits(db, "task-wait-loop")).toHaveLength(1);
    const state = db.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task-state' ORDER BY seq DESC LIMIT 1").get("task-wait-loop") as { payload: string };
    expect(JSON.parse(state.payload)).toMatchObject({ state: "WAITING" });
  });

  it("continues after a wake without duplicating the activation", async () => {
    const { db, base } = setup();
    const { waitId } = enterWait(db, "task-wait-loop", {
      kind: "process",
      condition: "sleeper still running",
      source: "process:proc_1",
      observedCursor: "bytes:0",
      obligation: "observe the sleeper",
    });
    const wakeId = levelWakeId("task-wait-loop", "process:proc_1", "exit:0");
    expect(recordWake(db, "task-wait-loop", {
      wakeId,
      waitId,
      edge: false,
      source: "process:proc_1",
      cursor: "exit:0",
      observation: "sleeper exited 0",
    })).toEqual({ duplicate: false, waitId, fired: true });
    let checks = 0;
    const stop = await runTaskLoop({
      ...base,
      provider: new FakeProvider([{ text: "observed the exit" }]),
      waiter: {
        check: () => {
          checks += 1;
          if (checks > 1) return null;
          const consumed = consumeFiredWait(db, "task-wait-loop", waitId);
          if (consumed === null) return null;
          return { woke: { text: consumed.observation } };
        },
      },
      acceptanceVerifiers: [() => ({ complete: true, reason: "exit observed" })],
    });
    expect(stop.decision).toBe("STOP");
    expect(modelAttempts(db)).toBe(1);
    // The same wake redelivered changes nothing: dedup is durable.
    expect(
      recordWake(db, "task-wait-loop", {
        wakeId,
        waitId,
        edge: false,
        source: "process:proc_1",
        cursor: "exit:0",
        observation: "sleeper exited 0",
      }),
    ).toEqual({ duplicate: true });
    expect(consumeFiredWait(db, "task-wait-loop", waitId)).toBeNull();
  });

  it("surfaces revisions that arrived mid-activation as evidence", async () => {    const { db, base } = setup();
    notePendingRevision(db, "task-wait-loop", 2, { text: "forbid network egress" });
    let seen = "";
    const stop = await runTaskLoop({
      ...base,
      provider: new FakeProvider([{ text: "noted" }]),
      waiter: { check: () => null },
      acceptanceVerifiers: [() => ({ complete: true, reason: "ok" })],
      onModelText: (text) => {
        seen = text;
      },
    });
    expect(stop.decision).toBe("STOP");
    expect(seen).toBe("noted");
    expect(modelAttempts(db)).toBe(1);
  });

  it("re-exits a stable wait on resume instead of calling the model", async () => {
    const { db, base } = setup();
    enterWait(db, "task-wait-loop", {
      kind: "process",
      condition: "sleeper still running",
      source: "process:proc_1",
      observedCursor: "bytes:0",
      obligation: "observe the sleeper",
    });
    // No handles noted, no fires delivered: the production waiter must pause
    // again with zero model calls rather than proceed.
    const waiter = new HandleWaiter(db, "task-wait-loop", {
      pollProcess: async () => ({ running: true as const }),
    }, "observe the sleeper");
    const stop = await runTaskLoop({ ...base, waiter });
    expect(stop.wait).toMatchObject({ kind: "process", condition: "sleeper still running" });
    expect(modelAttempts(db)).toBe(0);
  });
});
