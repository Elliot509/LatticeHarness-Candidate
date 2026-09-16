import { describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import { admitDurable, claimDurable } from "../../src/runtime/effects.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
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

// R1 regression: T0 grant vigente -> ADMITTED; T1 contract expires;
// T2 CLAIM must be DENIED with no dispatch (F-0001). The claim revalidates
// CURRENT authority inside the claim boundary; admit and claim are never
// assumed to be fast (crash/WAIT/queue can separate them arbitrarily).
describe("r1 expiry-after-admit", () => {
  it("RED: denies claim after contract expiry (durable)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1expiry-"));
    dirs.push(dir);
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const live = createContract({
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
    const admitted = admitDurable(
      opened.raw,
      live,
      { taskId: "task-1", operation: "read", target: "workspace/a.ts", actionKey: "r1-expiry", authorityRevision: 1, maxCalls: 1, maxTokens: 1000, argsJson: "{}" },
      GRANT,
      1,
    );
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    // T1: the contract expires with the same revision (time passes, no edit).
    const expired = { ...live, expiresAt: new Date(Date.now() - 1000).toISOString() };
    const claim = claimDurable(opened.raw, admitted.attemptId, 1, 1, { contract: expired });
    expect(claim).toMatchObject({ claimed: false, reason: "contract-expired" });
  });

  it("RED: denies claim when the granting grant expired after admission", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1grant-"));
    dirs.push(dir);
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const live = createContract({
      taskId: "task-1",
      rootId: "root-1",
      objective: "Read the file",
      scope: ["workspace"],
      acceptanceCriteria: ["file contents observed"],
      obligations: ["preserve baseline"],
      grants: [
        { subject: "agent", operations: ["read"], targets: ["workspace"], expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: ["publish"],
      realm: "local-trusted",
      allowedProvider: "fake",
      allowedModel: "fake-model-1",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "test",
    });
    const admitted = admitDurable(
      opened.raw,
      live,
      { taskId: "task-1", operation: "read", target: "workspace/a.ts", actionKey: "r1-grant", authorityRevision: 1, maxCalls: 1, maxTokens: 1000, argsJson: "{}" },
      GRANT,
      1,
    );
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    const expiredGrant = {
      ...live,
      grants: [
        { subject: "agent", operations: ["read"], targets: ["workspace"], expiresAt: new Date(Date.now() - 1000).toISOString(), limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
    };
    const claim = claimDurable(opened.raw, admitted.attemptId, 1, 1, { contract: expiredGrant });
    expect(claim.claimed).toBe(false);
    expect(["grant-expired", "operation-not-granted"]).toContain(
      (claim as { reason?: string }).reason ?? "",
    );
  });

  it("RED: denies claim when the grant was replaced with an incompatible one", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1digest-"));
    dirs.push(dir);
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const live = createContract({
      taskId: "task-1",
      rootId: "root-1",
      objective: "Read the file",
      scope: ["workspace"],
      acceptanceCriteria: ["file contents observed"],
      obligations: ["preserve baseline"],
      grants: [
        { subject: "agent", operations: ["read"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: [],
      realm: "local-trusted",
      allowedProvider: null,
      allowedModel: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "test",
    });
    const admitted = admitDurable(
      opened.raw,
      live,
      { taskId: "task-1", operation: "read", target: "workspace/a.ts", actionKey: "r1-digest", authorityRevision: 1, maxCalls: 1, maxTokens: 1000, argsJson: "{}" },
      GRANT,
      1,
    );
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    // Same revision, same operation, but the grant now covers exec instead:
    // the digest pins WHICH grant authorized, so the claim must refuse.
    // (Revision unchanged keeps this a pure grant-identity case: steering
    // would normally bump the revision, which alone already denies.)
    const replaced = {
      ...live,
      grants: [
        { subject: "agent", operations: ["exec"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
    };
    const claim = claimDurable(opened.raw, admitted.attemptId, 1, 1, { contract: replaced });
    expect(claim.claimed).toBe(false);
  });
});
