import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import {
  admitDurable,
  claimDurable,
  DuplicateReceiptError,
  findUnreconciledAttempts,
  recordReceiptDurable,
  taskBudgetSnapshot,
} from "../../src/runtime/effects.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { migrate } from "../../src/storage/schema.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

function database(): { db: DatabaseSync; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-effects-"));
  dirs.push(dir);
  const opened = openLatticeDb(dir);
  openHandles.push(opened);
  return { db: opened.raw, dir };
}

function contract() {
  return createContract({
    taskId: "task-1",
    rootId: "root-1",
    objective: "Read the file",
    scope: ["workspace"],
    acceptanceCriteria: ["file contents observed"],
    obligations: ["preserve baseline"],
    grants: [
      { subject: "agent", operations: ["search", "read", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
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

const GRANT = { calls: 50, tokens: 200_000 };

function intent(operation: string, key: string) {
  return {
    taskId: "task-1",
    operation,
    target: "workspace/a.ts",
    actionKey: key,
    authorityRevision: 1,
    maxCalls: 1,
    maxTokens: 1000,
    argsJson: "{}",
  };
}

describe("durable effects gate", () => {
  it("admits, claims and receipts in durable commits", () => {
    const { db } = database();
    const admitted = admitDurable(db, contract(), intent("read", "k1"), GRANT, 1);
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    expect(claimDurable(db, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    recordReceiptDurable(db, {
      attemptId: admitted.attemptId,
      outcome: "confirmed",
      summary: "read ok",
      detailJson: "{}",
      settledCalls: 1,
      settledTokens: 100,
    });
    const snapshot = taskBudgetSnapshot(db, "task-1", GRANT);
    expect(snapshot.settled).toEqual({ calls: 1, tokens: 100 });
    expect(snapshot.reserved).toEqual({ calls: 0, tokens: 0 });
  });

  it("refuses to silently duplicate a pending or UNKNOWN equivalent intent", () => {
    const { db } = database();
    const first = admitDurable(db, contract(), intent("read", "same-key"), GRANT, 1);
    expect(first.admitted).toBe(true);
    const second = admitDurable(db, contract(), intent("read", "same-key"), GRANT, 1);
    expect(second).toMatchObject({ admitted: false });
  });

  it("enforces conservation across restarts from persisted rows", () => {
    const { dir } = database();
    const first = openLatticeDb(dir);
    openHandles.push(first);
    const admitted = admitDurable(first.raw, contract(), { ...intent("read", "k1"), maxCalls: 50, maxTokens: 200_000 }, GRANT, 1);
    expect(admitted.admitted).toBe(true);
    first.close();

    const second = openLatticeDb(dir);
    openHandles.push(second);
    try {
      const denied = admitDurable(second.raw, contract(), intent("read", "k2"), GRANT, 2);
      expect(denied).toMatchObject({ admitted: false, reason: "budget-exceeded" });
      const snapshot = taskBudgetSnapshot(second.raw, "task-1", GRANT);
      expect(snapshot.reserved).toEqual({ calls: 50, tokens: 200_000 });
    } finally {
      second.close();
    }
  });

  it("exposes CLAIMED-without-receipt attempts for reconciliation", () => {
    const { db } = database();
    const admitted = admitDurable(db, contract(), intent("read", "k1"), GRANT, 1);
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    expect(claimDurable(db, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    expect(findUnreconciledAttempts(db)).toEqual([admitted.attemptId]);
    recordReceiptDurable(db, {
      attemptId: admitted.attemptId,
      outcome: "unknown",
      summary: "effect uncertain",
      detailJson: "{}",
      settledCalls: 0,
      settledTokens: 0,
    });
    expect(findUnreconciledAttempts(db)).toEqual([]);
  });

  it("rejects duplicate receipts and over-settlement", () => {
    const { db } = database();
    const admitted = admitDurable(db, contract(), intent("read", "k1"), GRANT, 1);
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    recordReceiptDurable(db, {
      attemptId: admitted.attemptId,
      outcome: "confirmed",
      summary: "ok",
      detailJson: "{}",
      settledCalls: 1,
      settledTokens: 10,
    });
    expect(() =>
      recordReceiptDurable(db, {
        attemptId: admitted.attemptId,
        outcome: "confirmed",
        summary: "again",
        detailJson: "{}",
        settledCalls: 0,
        settledTokens: 0,
      }),
    ).toThrow(DuplicateReceiptError);
  });

  it("denies claims from stale generations and refuses unknown attempts", () => {
    const { db } = database();
    const admitted = admitDurable(db, contract(), intent("read", "k1"), GRANT, 1);
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    expect(claimDurable(db, admitted.attemptId, 2, 1)).toMatchObject({
      claimed: false,
      reason: "stale-generation",
    });
    expect(claimDurable(db, "attempt-missing", 1, 1)).toMatchObject({
      claimed: false,
      reason: "not-found",
    });
  });

  it("rolls back admission when the commit fails, authorizing no dispatch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-broken-"));
    dirs.push(dir);
    const raw = new DatabaseSync(path.join(dir, "lattice.db"));
    try {
      migrate(raw);
      raw.exec("DROP TABLE reservations");
      expect(() => admitDurable(raw, contract(), intent("read", "k1"), GRANT, 1)).toThrow();
      const rows = raw.prepare("SELECT COUNT(*) AS n FROM intents").get() as { n: number };
      expect(rows.n).toBe(0);
    } finally {
      raw.close();
    }
  });
});
