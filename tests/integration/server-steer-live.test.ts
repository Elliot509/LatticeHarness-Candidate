import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership, type LatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import type { DatabaseSync } from "node:sqlite";
import type { ModelRequest, ModelResponse } from "../../src/providers/types.js";

let dirs: string[] = [];
let handles: LatticeDb[] = [];
afterEach(() => {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // Best effort cleanup.
    }
  }
  handles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function attemptCount(db: DatabaseSync, taskId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM attempts WHERE intent_id IN (SELECT intent_id FROM intents WHERE task_id = ?)")
    .get(taskId) as { n: number };
  return row.n;
}

describe("live steering during a run", () => {
  it("applies new obligations at a safe point without duplicating effects", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-steerlive-"));
    dirs.push(dir);
    const workspace = path.join(dir, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "a.txt"), "hello\n");
    const opened = openLatticeDb(path.join(dir, "data"));
    handles.push(opened);
    claimOwnership(opened.raw);
    const tasks = new TaskManager(opened.raw, workspace);

    const created = tasks.handleCommand({
      commandId: "live-create",
      kind: "create-task",
      payload: { workspace: "", objective: "Probe steering", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
    });
    if (!created.accepted || created.taskId === "") throw new Error("create-task denied");
    const taskId = created.taskId;

    let releaseSecondCall!: () => void;
    const secondCallGate = new Promise<void>((resolve) => {
      releaseSecondCall = resolve;
    });
    let calls = 0;
    const gated = {
      name: "gated",
      adapterRevision: "gated-1",
      complete: async (_request: ModelRequest): Promise<ModelResponse> => {
        calls += 1;
        if (calls === 1) {
          return {
            text: "",
            toolCalls: [{ id: "c1", name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"hello\"}" }],
            usage: null,
            modelResolved: "gated-1",
            providerRequestId: "r1",
          };
        }
        await secondCallGate;
        return { text: "done", toolCalls: [], usage: null, modelResolved: "gated-1", providerRequestId: "r2" };
      },
    };

    const started = tasks.startTask(taskId, "live-start", gated as never);
    expect(started).toMatchObject({ accepted: true, state: "RUNNING" });
    const deadline = Date.now() + 10000;
    while (attemptCount(opened.raw, taskId) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(attemptCount(opened.raw, taskId)).toBeGreaterThan(0);

    const steered = tasks.handleCommand({
      commandId: "live-steer",
      kind: "steer",
      taskId,
      expectedRevision: 1,
      payload: { text: "also check edge cases", mode: "guide" },
    });
    expect(steered).toMatchObject({ accepted: true, revision: 2 });
    releaseSecondCall();
    const doneDeadline = Date.now() + 15000;
    let state = tasks.snapshot(taskId).state;
    while ((state === "RUNNING" || state === "READY") && Date.now() < doneDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      state = tasks.snapshot(taskId).state;
    }
    expect(["NEEDS_INPUT", "COMPLETED", "BLOCKED", "CANCELLED"]).toContain(state);
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.contractRevision).toBe(2);
    expect(snapshot.steering).toHaveLength(1);
    expect(snapshot.steering[0]).toMatchObject({ state: "applied", appliedRevision: 2 });
    const revisions = opened.raw
      .prepare("SELECT DISTINCT authority_revision AS r FROM intents WHERE task_id = ? ORDER BY r")
      .all(taskId) as Array<{ r: number }>;
    expect(revisions.map((row) => row.r)).toContain(2);
  });
});
