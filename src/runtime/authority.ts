import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveInScope } from "../platform/paths.js";
import type { Grant, TaskContract } from "./contract.js";

// R1 authority kernel: one central evaluator for admission AND claim.
// AUTHORITY (machine-enforceable fields) is enforced here; GUIDANCE
// (free-text prohibitions, instructions) is only rendered to the model by
// the ContextCompiler and never denies. No NLP-as-policy, no LLM-as-judge,
// no heuristic substring matching of prohibition text.

export type AuthorityReason =
  | "contract-expired"
  | "grant-expired"
  | "operation-not-granted"
  | "target-not-granted"
  | "provider-not-granted"
  | "model-not-granted"
  | "realm-not-granted"
  | "restriction-denied"
  | "stale-revision"
  | "stale-generation";

export interface AuthorityIntent {
  operation: string;
  target: string | null;
  authorityRevision: number;
  provider?: string | undefined;
  model?: string | undefined;
  realm?: string | undefined;
}

export interface AuthorityExec {
  ownerGeneration: number;
  workspaceRoot: string;
  now?: Date | undefined;
}

export type AuthorityDecision =
  | { allowed: true; grantDigest: string }
  | { allowed: false; reason: AuthorityReason; detail: string };

// Operations whose target is a workspace-relative path and therefore falls
// under Grant.targets. exec/process carry free-form commands (executable,
// cwd, shell text), so their containment stays with resolveInScope at the
// tool boundary; the contract target gate does not pretend to cover them.
// search takes an optional root: the loop passes the search QUERY as the
// intent target, which must never be matched against grant paths (a query
// like "/etc/passwd" is content, not a path). Search authority is operation
// + containment of its root at the tool boundary; the gate therefore skips
// target matching for search while still enforcing operation/expiry/budget.
export const PATH_SCOPED_OPERATIONS: ReadonlySet<string> = new Set(["read", "edit"]);

function canonicalGrant(value: Grant): {
  subject: string;
  operations: string[];
  targets: string[];
  provider: string | null;
  expiresAt: string | null;
  limits: { maxCalls: number; maxTokens: number };
} {
  return {
    subject: value.subject,
    operations: [...value.operations].sort(),
    targets: [...value.targets].sort(),
    provider: value.provider ?? null,
    expiresAt: value.expiresAt,
    limits: { maxCalls: value.limits.maxCalls, maxTokens: value.limits.maxTokens },
  };
}

// Stable identity of the granting grant: SHA-256 over a canonical,
// secret-free serialization. Lets a claim prove it revalidates the SAME
// grant the admission was based on (grant-expired covers revocation-by-time;
// digest mismatch covers replacement with an incompatible grant).
export function grantDigest(grant: Grant): string {
  return createHash("sha256").update(JSON.stringify(canonicalGrant(grant)), "utf8").digest("hex");
}

function matchTargetEntry(entry: string, canonicalTarget: string): boolean {
  const normalized = entry.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalized === "" || normalized === ".") return true;
  if (canonicalTarget === normalized) return true;
  return canonicalTarget.startsWith(`${normalized}/`);
}

function segmentPrefixMatch(grantTarget: string, intentTarget: string): boolean {
  const segments = (value: string): string[] =>
    value.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  const grantParts = segments(grantTarget);
  const intentParts = segments(intentTarget);
  if (grantParts.length === 0) return true;
  if (intentParts.length < grantParts.length) return false;
  return grantParts.every((part, index) => intentParts[index] === part);
}

// Canonical, path-aware grant-target matching. When both roots exist on disk
// the check is symlink-safe through the canonical workspace containment
// primitive; when either side is missing (pure unit fixtures, not-yet-created
// targets) it falls back to a strict lexical comparison over normalized
// segments — still exact-segment, never substring. Absolute intent targets
// always deny: grant targets are workspace-relative by contract.
export function matchGrantTarget(grantTarget: string, intentTarget: string, workspaceRoot: string): boolean {
  if (path.isAbsolute(intentTarget)) return false;
  const rootLexical = path.resolve(workspaceRoot);
  const grantAbsolute = path.resolve(rootLexical, grantTarget);
  const intentAbsolute = path.resolve(rootLexical, intentTarget);
  // Symlink safety FIRST: a lexical match means nothing if the OS resolves
  // the intent outside the grant — but only when the workspace root itself
  // exists on disk. resolveInScope returns null both for escapes AND for
  // missing roots; a missing ROOT means there is nothing to contain against,
  // so pure fixtures fall through to the lexical fallback below. A missing
  // INTENT under an existing root still resolves (nearest-ancestor walk),
  // and a null there is a genuine escape → deny (unless nothing exists at
  // all, handled by intentExistsOnDisk).
  const rootExists = resolveInScope(workspaceRoot, ".") !== null;
  const canonicalIntent = resolveInScope(workspaceRoot, path.relative(rootLexical, intentAbsolute));
  const rootContained = resolveInScope(workspaceRoot, path.relative(rootLexical, grantAbsolute));
  if (rootContained !== null && canonicalIntent !== null) {
    const canonicalRoot = resolveInScope(workspaceRoot, ".") ?? rootLexical;
    const relativeGrant = path.relative(canonicalRoot, rootContained);
    const relativeIntent = path.relative(canonicalRoot, canonicalIntent);
    const normalizedGrant = relativeGrant === "" ? "." : relativeGrant.split(path.sep).join("/");
    const normalizedIntent = relativeIntent.split(path.sep).join("/");
    if (matchTargetEntry(normalizedGrant, normalizedIntent)) return true;
    // Canonical said no. Second chance ONLY for the legacy label case: the
    // grant entry does not exist on disk as a real directory (it is a
    // workspace label like "workspace"), while the intent resolved inside
    // the root. Real directory grants that canonically mismatch stay denied
    // (sibling-prefix protection). The label rule is still exact-segment
    // for multi-segment entries.
    if (!grantEntryExistsOnDisk(grantAbsolute) && isBareLabel(grantTarget, intentTarget)) return true;
    return false;
  }
  if (rootExists) {
    // Workspace exists. When BOTH sides resolve inside it, compare
    // canonically (symlink-safe). When the grant side is a label that does
    // not exist on disk (legacy scopes like "workspace" while the real tree
    // lives directly under the root), the canonical comparison is
    // meaningless — fall back to the lexical rule below, but ONLY if the
    // intent itself resolved inside the root (no escape, no symlink
    // breakout). An intent that fails containment under an existing root is
    // a genuine escape → deny. NOTE: resolveInScope resolves missing tails
    // through the nearest existing ancestor, so a null here is always a
    // real escape, never mere absence.
    if (canonicalIntent === null) return false;
    if (rootContained !== null) {
      const canonicalRoot = resolveInScope(workspaceRoot, ".") ?? rootLexical;
      const relativeGrant = path.relative(canonicalRoot, rootContained);
      const relativeIntent = path.relative(canonicalRoot, canonicalIntent);
      const normalizedGrant = relativeGrant === "" ? "." : relativeGrant.split(path.sep).join("/");
      const normalizedIntent = relativeIntent.split(path.sep).join("/");
      if (matchTargetEntry(normalizedGrant, normalizedIntent)) return true;
      // Canonical said no (e.g. grant label "workspace" resolved to a
      // sibling of the real tree): allow the legacy lexical rule as a
      // second chance, still exact-segment.
      return segmentPrefixMatch(grantTarget, normalizedIntent) || isBareLabel(grantTarget, intentTarget);
    }
    return segmentPrefixMatch(grantTarget, intentTarget) || isBareLabel(grantTarget, intentTarget);
  }
  // Lexical fallback (no workspace on disk: pure fixtures, label-style
  // scopes): strict segment comparison over the RAW requested strings.
  // Grant targets in this codebase are EITHER workspace labels ("workspace",
  // authorizing the whole task tree) OR workspace-relative paths ("src/a").
  // A bare label matches any in-scope relative target; a relative grant
  // entry must be an exact segment prefix of the intent. Still exact-segment
  // where it matters: "src/a" never covers "src/abc", and absolute escapes
  // plus symlink escapes are already denied above. Production resolves the
  // real workspace from the run manifest or an absolute scope, where the
  // canonical path above applies instead.
  return segmentPrefixMatch(grantTarget, intentTarget) || isBareLabel(grantTarget, intentTarget);
}

function grantEntryExistsOnDisk(grantAbsolute: string): boolean {
  try {
    return fs.statSync(grantAbsolute).isDirectory();
  } catch {
    return false;
  }
}

function isBareLabel(grantTarget: string, intentTarget: string): boolean {
  // Legacy workspace label: exactly the conventional "workspace" entry (the
  // scope string every server/CLI/test grant in this codebase carries) with
  // no such directory on disk. It authorizes the whole task tree. Any other
  // single-segment entry is a real directory name and must prefix-match.
  // Labels must not look like filenames; intents must be relative (absolute
  // already denied above).
  const segments = (value: string): string[] =>
    value.replace(/\\/g, "/").split("/").filter((part) => part !== "" && part !== ".");
  const grantParts = segments(grantTarget);
  const intentParts = segments(intentTarget);
  if (grantParts.length !== 1 || intentParts.length === 0) return false;
  if (segmentPrefixMatch(grantTarget, intentTarget)) return true;
  const label = grantParts[0] as string;
  if (label.includes(".")) return false;
  return label === "workspace";
}

function deny(reason: AuthorityReason, detail: string): AuthorityDecision {
  return { allowed: false, reason, detail };
}

export function evaluateAuthority(
  contract: TaskContract,
  intent: AuthorityIntent,
  exec: AuthorityExec,
): AuthorityDecision {
  const now = exec.now ?? new Date();
  if (Date.parse(contract.expiresAt) <= now.getTime()) {
    return deny("contract-expired", `Contract for task ${contract.taskId} expired at ${contract.expiresAt}`);
  }
  if (intent.authorityRevision !== contract.revision) {
    return deny(
      "stale-revision",
      `Intent expects revision ${intent.authorityRevision} but contract is at ${contract.revision}`,
    );
  }
  const candidates = contract.grants.filter((grant) => grant.operations.includes(intent.operation));
  if (candidates.length === 0) {
    return deny("operation-not-granted", `No grant covers operation ${intent.operation}`);
  }
  const live = candidates.filter(
    (grant) => grant.expiresAt === null || Date.parse(grant.expiresAt) > now.getTime(),
  );
  if (live.length === 0) {
    return deny("grant-expired", `Grants covering ${intent.operation} all expired`);
  }
  // Deterministic grant selection: first live grant wins (documented order).
  // The digest pins WHICH grant authorized, so claim revalidates the same one.
  const grant = live[0] as Grant;
  const digest = grantDigest(grant);
  if (exec.ownerGeneration <= 0) {
    return deny("stale-generation", "No owner generation claimed; dispatch is not authorized");
  }
  const realm = intent.realm ?? contract.realm;
  if (realm !== contract.realm) {
    return deny("realm-not-granted", `Intent realm ${realm} does not match contract realm ${contract.realm}`);
  }
  if (intent.provider !== undefined && contract.allowedProvider !== null && intent.provider !== contract.allowedProvider) {
    return deny("provider-not-granted", `Provider ${intent.provider} is not the allowed provider ${contract.allowedProvider}`);
  }
  if (intent.model !== undefined && contract.allowedModel !== null && intent.model !== contract.allowedModel) {
    return deny("model-not-granted", `Model ${intent.model} is not the allowed model ${contract.allowedModel}`);
  }
  if (PATH_SCOPED_OPERATIONS.has(intent.operation) && intent.target !== null) {
    const covered = grant.targets.some((entry) => matchGrantTarget(entry, intent.target as string, exec.workspaceRoot));
    if (!covered) {
      return deny("target-not-granted", `Target ${intent.target} is outside every grant target for ${intent.operation}`);
    }
  }
  const restrictions = contract.restrictions;
  if (restrictions !== undefined) {
    if (restrictions.denyOperations?.includes(intent.operation) === true) {
      return deny("restriction-denied", `Operation ${intent.operation} is denied by a typed hard restriction`);
    }
    if (intent.target !== null) {
      const hit = restrictions.denyTargets?.some((entry) => {
        if (path.isAbsolute(intent.target as string)) return true;
        return matchGrantTarget(entry, intent.target as string, exec.workspaceRoot);
      });
      if (hit === true) return deny("restriction-denied", `Target ${intent.target} is denied by a typed hard restriction`);
    }
    if (intent.provider !== undefined && restrictions.denyProviders?.includes(intent.provider) === true) {
      return deny("restriction-denied", `Provider ${intent.provider} is denied by a typed hard restriction`);
    }
    if (intent.model !== undefined && restrictions.denyModels?.includes(intent.model) === true) {
      return deny("restriction-denied", `Model ${intent.model} is denied by a typed hard restriction`);
    }
    if (restrictions.denyRealms?.includes(realm) === true) {
      return deny("restriction-denied", `Realm ${realm} is denied by a typed hard restriction`);
    }
  }
  // NOTE: contract.prohibitions (free text) is GUIDANCE, never hard policy:
  // it is rendered to the model and audited, but cannot deny here by design.
  return { allowed: true, grantDigest: digest };
}
