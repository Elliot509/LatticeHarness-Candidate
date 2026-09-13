import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { armFault, clearFaults } from "../../src/runtime/faults.js";
import {
  cancelActiveWaits,
  consumeFiredWait,
  dueWaits,
  edgeWakeId,
  enterWait,
  levelWakeId,
  listActiveWaits,
  notePendingRevision,
  recordWake,
  takePendingRevisions,
} from "../../src/runtime/wait.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";

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

function database(): LatticeDb["raw"] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-wait-"));
  dirs.push(dir);
  const opened = openLatticeDb(dir);
  openHandles.push(opened);
  return opened.raw;
}

const TASK = "task-wait-1";
const REQUEST = {
  kind: "process" as const,
  condition: "process proc_abc still running",
  source: "process:proc_abc",
  observedCursor: "bytes:0",
  obligation: "observe the migration run to completion",
};

describe("wait entry", () => {
  it("enters once and returns the existing wait on re-entry", () => {
    const db = database();
    const first = enterWait(db, TASK, REQUEST);
    expect(first.created).toBe(true);
    const second = enterWait(db, TASK, REQUEST);
    expect(second.created).toBe(false);
    expect(second.waitId).toBe(first.waitId);
    expect(listActiveWaits(db, TASK)).toHaveLength(1);
  });

  it("supports a deadline that fires only after expiry", () => {
    const db = database();
    enterWait(db, TASK, { ...REQUEST, kind: "deadline", condition: "retry after cooldown", deadline: new Date(Date.now() + 60_000).toISOString() });
    expect(dueWaits(db, new Date(Date.now() - 1000))).toHaveLength(0);
    const due = dueWaits(db, new Date(Date.now() + 61_000));
    expect(due).toHaveLength(1);
    expect(due[0]?.condition).toBe("retry after cooldown");
  });

  it("cancels active waits without touching history", () => {
    const db = database();
    enterWait(db, TASK, REQUEST);
    const cancelled = cancelActiveWaits(db, TASK, "loop decided");
    expect(cancelled).toHaveLength(1);
    expect(listActiveWaits(db, TASK)).toHaveLength(0);
  });
});

describe("wake gate", () => {
  it("fires once and treats redelivery of the same observation as duplicate", () => {
    const db = database();
    const { waitId } = enterWait(db, TASK, REQUEST);
    const wakeId = levelWakeId(TASK, REQUEST.source, "bytes:4096");
    const first = recordWake(db, TASK, {
      wakeId,
      waitId,
      edge: false,
      source: REQUEST.source,
      cursor: "bytes:4096",
      observation: "process emitted 4096 bytes",
    });
    expect(first).toEqual({ duplicate: false, waitId, fired: true });
    const again = recordWake(db, TASK, {
      wakeId,
      waitId,
      edge: false,
      source: REQUEST.source,
      cursor: "bytes:4096",
      observation: "process emitted 4096 bytes",
    });
    expect(again).toEqual({ duplicate: true });
    const consumed = consumeFiredWait(db, TASK, waitId);
    expect(consumed).toEqual({ observation: "process emitted 4096 bytes" });
    expect(consumeFiredWait(db, TASK, waitId)).toBeNull();
    expect(listActiveWaits(db, TASK)).toHaveLength(0);
  });

  it("never coalesces edge events: each input is its own wake", () => {
    const db = database();
    const { waitId } = enterWait(db, TASK, { ...REQUEST, kind: "input", condition: "human decision pending" });
    const first = recordWake(db, TASK, {
      wakeId: edgeWakeId(),
      waitId,
      edge: true,
      source: "input",
      cursor: "msg-1",
      observation: "human chose option A",
    });
    expect(first.duplicate).toBe(false);
    const second = recordWake(db, TASK, {
      wakeId: edgeWakeId(),
      waitId,
      edge: true,
      source: "input",
      cursor: "msg-2",
      observation: "human revoked option A",
    });
    // The second edge wake arrives after the wait fired; it is still
    // recorded as its own observation, never merged into the first.
    expect(second.duplicate).toBe(false);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM wake_events WHERE task_id = ?").get(TASK) as { n: number };
    expect(rows.n).toBe(2);
  });

  it("holds the cursor when the commit fails and accepts the redelivery", () => {
    const db = database();
    const { waitId } = enterWait(db, TASK, REQUEST);
    armFault("before-cursor-commit");
    expect(() =>
      recordWake(db, TASK, {
        wakeId: levelWakeId(TASK, REQUEST.source, "bytes:1"),
        waitId,
        edge: false,
        source: REQUEST.source,
        cursor: "bytes:1",
        observation: "first byte",
      }),
    ).toThrow();
    clearFaults();
    const rows = db.prepare("SELECT COUNT(*) AS n FROM wake_events WHERE task_id = ?").get(TASK) as { n: number };
    expect(rows.n).toBe(0);
    expect(listActiveWaits(db, TASK).map((wait) => wait.observedCursor)).toEqual(["bytes:0"]);
    const redelivered = recordWake(db, TASK, {
      wakeId: levelWakeId(TASK, REQUEST.source, "bytes:1"),
      waitId,
      edge: false,
      source: REQUEST.source,
      cursor: "bytes:1",
      observation: "first byte",
    });
    expect(redelivered).toEqual({ duplicate: false, waitId, fired: true });
  });
});

describe("pending revisions", () => {
  it("persists revisions arriving mid-activation and takes them exactly once", () => {
    const db = database();
    notePendingRevision(db, TASK, 4, { text: "forbid /tmp writes" });
    notePendingRevision(db, TASK, 4, { text: "forbid /tmp writes" });
    notePendingRevision(db, TASK, 5, { text: "extend deadline" });
    const taken = takePendingRevisions(db, TASK);
    expect(taken.map((entry) => entry.revision)).toEqual([4, 5]);
    expect(takePendingRevisions(db, TASK)).toEqual([]);
  });
});
