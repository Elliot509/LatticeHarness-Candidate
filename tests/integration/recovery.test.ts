import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import {
  admitDurable,
  claimDurable,
  findUnreconciledAttempts,
  reconcileEditAttempt,
  recordReceiptDurable,
  recordUsageRevision,
  releaseReservation,
  taskBudgetSnapshot,
} from "../../src/runtime/effects.js";
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

function track(handle: LatticeDb): LatticeDb {
  openHandles.push(handle);
  return handle;
}

function database() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-recovery-"));
  dirs.push(dir);
  return { dir, opened: track(openLatticeDb(dir)) };
}

function contract() {
  return createContract({
    taskId: "task-1",
    rootId: "root-1",
    objective: "Edit with recovery",
    scope: ["workspace"],
    acceptanceCriteria: ["file updated"],
    obligations: ["preserve baseline"],
    grants: [
      { subject: "agent", operations: ["edit", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
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

function editIntent(key: string, expectedVersion: string) {
  return {
    taskId: "task-1",
    operation: "edit",
    target: "workspace/a.txt",
    actionKey: key,
    authorityRevision: 1,
    maxCalls: 0,
    maxTokens: 0,
    argsJson: JSON.stringify({ kind: "replace", path: "a.txt", expectedVersion }),
  };
}

describe("crash recovery without replay", () => {
  it("recovers a CLAIMED-without-receipt attempt as UNKNOWN after restart", () => {
    const { dir } = database();
    const first = track(openLatticeDb(dir));
    const admitted = admitDurable(first.raw, contract(), editIntent("k1", "sha256:before"), GRANT, 1);
    if (!admitted.admitted) throw new Error("admission failed");
    expect(claimDurable(first.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    const before = (first.raw.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number }).n;
    first.close();

    const second = track(openLatticeDb(dir));
    try {
      expect(findUnreconciledAttempts(second.raw)).toEqual([admitted.attemptId]);
      const counts = (second.raw.prepare(
        "SELECT (SELECT COUNT(*) FROM intents) AS i, (SELECT COUNT(*) FROM attempts) AS a, (SELECT COUNT(*) FROM receipts) AS r",
      ).get() as { i: number; a: number; r: number });
      expect(counts).toEqual({ i: 1, a: 1, r: before });
    } finally {
      second.close();
    }
  });

  it("reconciles an applied edit from the retained after-version", () => {
    const { dir } = database();
    const opened = track(openLatticeDb(dir));
    try {
      const admitted = admitDurable(opened.raw, contract(), editIntent("k1", "sha256:before"), GRANT, 1);
      if (!admitted.admitted) throw new Error("admission failed");
      expect(claimDurable(opened.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
      recordReceiptDurable(opened.raw, {
        attemptId: admitted.attemptId,
        outcome: "unknown",
        summary: "crash before confirmation",
        detailJson: JSON.stringify({ afterVersion: "sha256:after" }),
        settledCalls: 0,
        settledTokens: 0,
      });
      const result = reconcileEditAttempt(opened.raw, admitted.attemptId, "sha256:after");
      expect(result.result).toBe("applied");
      expect(findUnreconciledAttempts(opened.raw)).toEqual([]);
    } finally {
      opened.close();
    }
  });

  it("reconciles a never-applied edit as safe to readmit", () => {
    const { dir } = database();
    const opened = track(openLatticeDb(dir));
    try {
      const admitted = admitDurable(opened.raw, contract(), editIntent("k1", "sha256:before"), GRANT, 1);
      if (!admitted.admitted) throw new Error("admission failed");
      expect(claimDurable(opened.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
      recordReceiptDurable(opened.raw, {
        attemptId: admitted.attemptId,
        outcome: "unknown",
        summary: "crash before invocation",
        detailJson: "{}",
        settledCalls: 0,
        settledTokens: 0,
      });
      const result = reconcileEditAttempt(opened.raw, admitted.attemptId, "sha256:before");
      expect(result.result).toBe("not-applied");
      const readmitted = admitDurable(opened.raw, contract(), editIntent("k1", "sha256:before"), GRANT, 1);
      expect(readmitted.admitted).toBe(true);
    } finally {
      opened.close();
    }
  });

  it("keeps divergent content as conflict for a human", () => {
    const { dir } = database();
    const opened = track(openLatticeDb(dir));
    try {
      const admitted = admitDurable(opened.raw, contract(), editIntent("k1", "sha256:before"), GRANT, 1);
      if (!admitted.admitted) throw new Error("admission failed");
      expect(claimDurable(opened.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
      recordReceiptDurable(opened.raw, {
        attemptId: admitted.attemptId,
        outcome: "unknown",
        summary: "uncertain",
        detailJson: JSON.stringify({ afterVersion: "sha256:after" }),
        settledCalls: 0,
        settledTokens: 0,
      });
      const result = reconcileEditAttempt(opened.raw, admitted.attemptId, "sha256:someone-else");
      expect(result.result).toBe("conflict");
    } finally {
      opened.close();
    }
  });

  it("holds the token ceiling on unknown usage and releases it on correction", () => {
    const { dir } = database();
    const opened = track(openLatticeDb(dir));
    try {
      const admitted = admitDurable(
        opened.raw,
        contract(),
        {
          taskId: "task-1",
          operation: "model.invoke",
          target: "fake/m",
          actionKey: "model:fake:m:1",
          authorityRevision: 1,
          maxCalls: 1,
          maxTokens: 4000,
          argsJson: "{}",
        },
        GRANT,
        1,
      );
      if (!admitted.admitted) throw new Error("admission failed");
      expect(claimDurable(opened.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
      recordReceiptDurable(opened.raw, {
        attemptId: admitted.attemptId,
        outcome: "confirmed",
        summary: "responded; usage unknown",
        detailJson: JSON.stringify({ coverage: "unknown" }),
        settledCalls: 1,
        settledTokens: 0,
        releaseUnused: false,
      });
      const held = taskBudgetSnapshot(opened.raw, "task-1", GRANT);
      expect(held.settled).toEqual({ calls: 1, tokens: 0 });
      expect(held.reserved).toEqual({ calls: 0, tokens: 4000 });

      const revision = recordUsageRevision(opened.raw, admitted.attemptId, JSON.stringify({ inputTotal: 100 }));
      expect(revision).toBe(1);
      const revision2 = recordUsageRevision(opened.raw, admitted.attemptId, JSON.stringify({ inputTotal: 120 }));
      expect(revision2).toBe(2);
      releaseReservation(opened.raw, admitted.intentId);
      const released = taskBudgetSnapshot(opened.raw, "task-1", GRANT);
      expect(released.reserved).toEqual({ calls: 0, tokens: 0 });
      expect(released.settled).toEqual({ calls: 1, tokens: 0 });
    } finally {
      opened.close();
    }
  });

  it("denies claims after a generation takeover", () => {
    const { dir } = database();
    const opened = track(openLatticeDb(dir));
    try {
      const admitted = admitDurable(opened.raw, contract(), editIntent("k1", "sha256:before"), GRANT, 1);
      if (!admitted.admitted) throw new Error("admission failed");
      expect(claimDurable(opened.raw, admitted.attemptId, 2, 1)).toMatchObject({
        claimed: false,
        reason: "stale-generation",
      });
      expect(findUnreconciledAttempts(opened.raw)).toEqual([]);
    } finally {
      opened.close();
    }
  });
});
