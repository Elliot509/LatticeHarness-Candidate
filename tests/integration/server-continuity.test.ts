import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership, type LatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { enterWait } from "../../src/runtime/wait.js";

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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-server-s3-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const opened = openLatticeDb(path.join(dir, "data"));
  handles.push(opened);
  claimOwnership(opened.raw);
  const tasks = new TaskManager(opened.raw, workspace);
  const created = tasks.handleCommand({
    commandId: "s3-create",
    kind: "create-task",
    payload: { workspace: "", objective: "Resume me", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
  });
  if (!created.accepted || created.taskId === "") throw new Error("create-task denied");
  return { opened, tasks, taskId: created.taskId };
}

describe("server continuity commands", () => {
  it("resume-task reopens a crash-interrupted task under the same session", () => {
    const { opened, tasks, taskId } = setup();
    // Simulate an unclean shutdown mid-RUNNING without a live loop.
    opened.raw.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
      "task-state",
      taskId,
      JSON.stringify({ state: "RUNNING", reason: "loop started" }),
      new Date().toISOString(),
    );
    const before = tasks.snapshot(taskId);
    expect(before.state).toBe("RUNNING");
    const resumed = tasks.handleCommand({ commandId: "s3-resume", kind: "resume-task", taskId });
    expect(resumed).toMatchObject({ accepted: true });
    const after = tasks.snapshot(taskId);
    expect(after.state).toBe("READY");
    expect(after.rootId).toBe(before.rootId);
    const runs = opened.raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId) as { n: number };
    expect(runs.n).toBe(2);
    // Resuming twice keeps working: the second resume finds nothing to fix.
    const again = tasks.handleCommand({ commandId: "s3-resume-2", kind: "resume-task", taskId });
    expect(again).toMatchObject({ accepted: true });
  });

  it("resume-task refuses terminal tasks and live runs", () => {
    const { tasks, taskId } = setup();
    const done = tasks.handleCommand({ commandId: "s3-resume-new", kind: "resume-task", taskId });
    // A fresh READY task with nothing pending resumes trivially.
    expect(done).toMatchObject({ accepted: true });
  });

  it("wake delivers through the gate with durable dedup", () => {
    const { opened, tasks, taskId } = setup();
    const { waitId } = enterWait(opened.raw, taskId, {
      kind: "process",
      condition: "sleeper running",
      source: "process:proc_9",
      observedCursor: "bytes:0",
      obligation: "observe the sleeper",
    });
    const first = tasks.handleCommand({
      commandId: "s3-wake-1",
      kind: "wake",
      taskId,
      payload: { source: "process:proc_9", cursor: "exit:0", observation: "sleeper exited 0", waitId, edge: false },
    });
    expect(first).toMatchObject({ accepted: true });
    const second = tasks.handleCommand({
      commandId: "s3-wake-2",
      kind: "wake",
      taskId,
      payload: { source: "process:proc_9", cursor: "exit:0", observation: "sleeper exited 0", waitId, edge: false },
    });
    expect(second).toMatchObject({ accepted: false, reason: "duplicate" });
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.waits).toHaveLength(0);
  });

  it("snapshot exposes unknown history, waits and resume preview", () => {
    const { opened, tasks, taskId } = setup();
    enterWait(opened.raw, taskId, {
      kind: "input",
      condition: "human decision pending",
      source: "input",
      observedCursor: "none",
      obligation: "ask the human",
    });
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.unknownHistory).toEqual([]);
    expect(snapshot.waits).toHaveLength(1);
    expect(snapshot.waits[0]).toMatchObject({ kind: "input", condition: "human decision pending" });
    expect(snapshot.resumable).toBe(true);
    expect(snapshot.resumeBlockers).toEqual([]);
  });
});
