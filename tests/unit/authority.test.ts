import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateAuthority,
  grantDigest,
  matchGrantTarget,
  PATH_SCOPED_OPERATIONS,
  type AuthorityExec,
  type AuthorityIntent,
} from "../../src/runtime/authority.js";
import { createContract, type TaskContract } from "../../src/runtime/contract.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-authority-"));
  dirs.push(dir);
  return dir;
}

const LIVE = new Date(Date.now() + 30 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 1000).toISOString();

function contract(overrides: Partial<Omit<TaskContract, "revision">> = {}): TaskContract {
  return createContract({
    taskId: "task-1",
    rootId: "root-1",
    objective: "Fix the failing test",
    scope: ["workspace/src"],
    acceptanceCriteria: ["relevant test passes"],
    obligations: ["preserve baseline"],
    grants: [
      {
        subject: "agent",
        operations: ["read", "edit"],
        targets: ["workspace/src"],
        expiresAt: null,
        limits: { maxCalls: 50, maxTokens: 200000 },
      },
    ],
    prohibitions: ["publish"],
    realm: "local-trusted",
    allowedProvider: "acme",
    allowedModel: "m1",
    expiresAt: LIVE,
    retentionPolicy: "retain until explicit deletion",
    origin: "user setup",
    ...overrides,
  });
}

function intent(overrides: Partial<AuthorityIntent> = {}): AuthorityIntent {
  return {
    operation: "read",
    target: "workspace/src/a.ts",
    authorityRevision: 1,
    ...overrides,
  };
}

function exec(overrides: Partial<AuthorityExec> = {}): AuthorityExec {
  return { ownerGeneration: 3, workspaceRoot: tmp(), ...overrides };
}

describe("authority evaluator", () => {
  it("allows a covered intent and fingerprints the granting grant deterministically", () => {
    const first = evaluateAuthority(contract(), intent(), exec());
    const second = evaluateAuthority(contract(), intent(), exec());
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    if (!first.allowed || !second.allowed) return;
    expect(first.grantDigest).toBe(second.grantDigest);
    expect(first.grantDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("denies expired contracts and stale revisions or generations", () => {
    expect(evaluateAuthority(contract({ expiresAt: PAST }), intent(), exec())).toMatchObject({
      allowed: false,
      reason: "contract-expired",
    });
    expect(evaluateAuthority(contract(), intent({ authorityRevision: 7 }), exec())).toMatchObject({
      allowed: false,
      reason: "stale-revision",
    });
    expect(evaluateAuthority(contract(), intent(), exec({ ownerGeneration: 0 }))).toMatchObject({
      allowed: false,
      reason: "stale-generation",
    });
  });

  it("denies operations without a grant, including expiry masquerading as absence", () => {
    expect(evaluateAuthority(contract(), intent({ operation: "exec" }), exec())).toMatchObject({
      allowed: false,
      reason: "operation-not-granted",
    });
    const onlyExpired = contract({
      grants: [
        {
          subject: "agent",
          operations: ["exec"],
          targets: ["workspace"],
          expiresAt: PAST,
          limits: { maxCalls: 5, maxTokens: 1000 },
        },
      ],
    });
    const denied = evaluateAuthority(onlyExpired, { operation: "exec", target: null, authorityRevision: 1 }, exec());
    expect(denied).toMatchObject({ allowed: false, reason: "grant-expired" });
  });

  it("denies path targets outside the grant, including absolute escape", () => {
    const root = tmp();
    const denied = evaluateAuthority(
      contract(),
      intent({ operation: "edit", target: "/etc/passwd" }),
      { ownerGeneration: 1, workspaceRoot: root },
    );
    expect(denied).toMatchObject({ allowed: false, reason: "target-not-granted" });
  });

  it("does not confuse sibling prefixes as containment", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src", "a"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "abc"), { recursive: true });
    const scoped = contract({
      scope: [root],
      grants: [
        { subject: "agent", operations: ["read"], targets: ["src/a"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
    });
    expect(matchGrantTarget("src/a", "src/abc/file.txt", root)).toBe(false);
    expect(matchGrantTarget("src/a", "src/a/file.txt", root)).toBe(true);
    const denied = evaluateAuthority(scoped, { operation: "read", target: "src/abc/file.txt", authorityRevision: 1 }, { ownerGeneration: 1, workspaceRoot: root });
    expect(denied).toMatchObject({ allowed: false, reason: "target-not-granted" });
  });

  it("treats a missing single-segment grant entry as a workspace label", () => {
    // Legacy scopes ("workspace") predate absolute workspace resolution: the
    // label authorizes the whole task tree when no such directory exists.
    // A DIFFERENT missing label ("other") authorizes nothing: labels are
    // matched by convention ("workspace"), not by any-single-segment.
    const root = tmp();
    expect(matchGrantTarget("workspace", "src/sum.js", root)).toBe(true);
    expect(matchGrantTarget("other", "src/sum.js", root)).toBe(false);
    expect(matchGrantTarget("workspace", "/etc/passwd", root)).toBe(false);
  });

  it("resolves symlinks against the grant instead of trusting lexical paths", () => {
    const root = tmp();
    const outside = tmp();
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "x");
    try {
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "sub", "link.txt"));
    } catch {
      return;
    }
    expect(matchGrantTarget("sub", "sub/link.txt", root)).toBe(false);
    expect(matchGrantTarget(".", "sub/real.txt", root)).toBe(true);
  });

  it("enforces provider, model and realm bindings where they apply", () => {
    const modelOp: AuthorityIntent = { operation: "model.invoke", target: "acme/m1", authorityRevision: 1, provider: "acme", model: "m1" };
    const modelContract = contract({
      grants: [{ subject: "agent", operations: ["model.invoke"], targets: [], expiresAt: null, limits: { maxCalls: 5, maxTokens: 1000 } }],
    });
    const allowed = evaluateAuthority(modelContract, modelOp, exec());
    expect(allowed.allowed).toBe(true);
    expect(
      evaluateAuthority(modelContract, { ...modelOp, provider: "evil" }, exec()),
    ).toMatchObject({ allowed: false, reason: "provider-not-granted" });
    expect(
      evaluateAuthority(modelContract, { ...modelOp, model: "evil" }, exec()),
    ).toMatchObject({ allowed: false, reason: "model-not-granted" });
    expect(
      evaluateAuthority(contract(), intent({ realm: "other-realm" }), exec()),
    ).toMatchObject({ allowed: false, reason: "realm-not-granted" });
  });

  it("enforces typed hard restrictions but never free-text prohibitions", () => {
    const restricted = contract({
      grants: [
        { subject: "agent", operations: ["exec", "read"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      restrictions: { denyOperations: ["exec"] },
    });
    expect(
      evaluateAuthority(restricted, { operation: "exec", target: null, authorityRevision: 1 }, exec()),
    ).toMatchObject({ allowed: false, reason: "restriction-denied" });
    // Free text stays guidance: even an emphatic prohibition never denies.
    const advisory = contract({ prohibitions: ["forbid everything, especially read"] });
    expect(evaluateAuthority(advisory, intent(), exec()).allowed).toBe(true);
  });

  it("publishes the path-scoped operation set explicitly", () => {
    expect([...PATH_SCOPED_OPERATIONS].sort()).toEqual(["edit", "read"]);
  });

  it("fingerprints grants without secrets and distinguishes grants", () => {
    const a = { subject: "agent", operations: ["read"], targets: ["b", "a"], expiresAt: null, limits: { maxCalls: 1, maxTokens: 1 } } as const;
    const b = { subject: "agent", operations: ["read"], targets: ["a", "b"], expiresAt: null, limits: { maxCalls: 1, maxTokens: 1 } } as const;
    expect(grantDigest({ ...a, targets: [...a.targets] })).toBe(grantDigest({ ...b, targets: [...b.targets] }));
    expect(grantDigest({ ...a, targets: ["other"], operations: [...a.operations], limits: { ...a.limits } })).not.toBe(
      grantDigest({ ...b, targets: [...b.targets], operations: [...b.operations], limits: { ...b.limits } }),
    );
  });
});
