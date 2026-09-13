import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { invalidateAdmittedIntent, receiptEffectVersions, taskBudgetSnapshot } from "./effects.js";
import { listActiveWaits, type WaitRecord } from "./wait.js";
import { isContractExpired, type TaskContract } from "./contract.js";

// S3 continuity: manual resume over durable state. This module never creates
// authority, never renews grants or budgets, never replays effects and never
// starts the model. It rebuilds what is known, classifies what is pending,
// and reports whether continuation is safe. Restart is reconstruction, not
// replay.

export interface SessionHandle {
  sessionId: string;
  rootId: string;
}

export function openSession(db: DatabaseSync, rootId: string): SessionHandle {
  const row = db
    .prepare("SELECT session_id FROM runs WHERE root_id = ? ORDER BY created_at ASC LIMIT 1")
    .get(rootId) as { session_id: string } | undefined;
  if (row !== undefined) return { sessionId: row.session_id, rootId };
  return { sessionId: `session-${randomUUID()}`, rootId };
}

export function openRun(
  db: DatabaseSync,
  input: { sessionId: string; rootId: string; taskId: string; manifest: Record<string, unknown> },
  now: Date = new Date(),
): string {
  const runId = `run-${randomUUID()}`;
  db.prepare(
    "INSERT INTO runs (run_id, session_id, root_id, task_id, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(runId, input.sessionId, input.rootId, input.taskId, JSON.stringify(input.manifest), now.toISOString());
  return runId;
}

export interface SessionRow {
  sessionId: string;
  rootId: string;
  taskId: string;
  workspace: string;
  objective: string;
  state: string;
  updatedAt: string;
}
export function listSessions(db: DatabaseSync, limit = 100): SessionRow[] {
  // One row per task at its latest run: resumed tasks keep their session
  // across runs and must not appear twice.
  const rows = db
    .prepare(
      `SELECT r.session_id, r.root_id, r.task_id, r.created_at, c.document
       FROM runs r LEFT JOIN contracts c ON c.task_id = r.task_id
       WHERE r.created_at = (SELECT MAX(created_at) FROM runs WHERE task_id = r.task_id)
       ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    session_id: string;
    root_id: string;
    task_id: string;
    created_at: string;
    document: string | null;
  }>;
  return rows.map((row) => {
    let objective = "";
    let workspace = "";
    if (row.document !== null) {
      try {
        const contract = JSON.parse(row.document) as { objective?: unknown; scope?: unknown };
        if (typeof contract.objective === "string") objective = contract.objective;
        if (Array.isArray(contract.scope) && typeof contract.scope[0] === "string") {
          workspace = contract.scope[0];
        }
      } catch {
        // Corrupt document surfaces as blank, never crashes the list.
      }
    }
    return {
      sessionId: row.session_id,
      rootId: row.root_id,
      taskId: row.task_id,
      workspace,
      objective,
      state: readTaskState(db, row.task_id).state,
      updatedAt: row.created_at,
    };
  });
}

// Granted budget is always derived from the persisted contract grants, so a
// restart can never renew it. Prefers the grant covering model.invoke.
export function grantedFromContract(contract: TaskContract): { calls: number; tokens: number } {
  const modelGrant = contract.grants.find((grant) => grant.operations.includes("model.invoke"));
  const grant = modelGrant ?? contract.grants[0];
  if (grant === undefined) throw new Error(`contract ${contract.taskId} carries no grants`);
  return { calls: grant.limits.maxCalls, tokens: grant.limits.maxTokens };
}
export function recordTaskEvent(db: DatabaseSync, taskId: string, kind: string, payload: Record<string, unknown>): void {
  db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
    kind,
    taskId,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
}

export interface VerificationEvidence {
  command: string;
  cwd: string;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  countsKnown: boolean;
}

// Verification outcomes persist as events so a resumed session can answer
// what was already verified without rerunning anything.
export function recordVerificationEvent(db: DatabaseSync, taskId: string, evidence: VerificationEvidence): void {
  recordTaskEvent(db, taskId, "verification", { ...evidence });
}

export function readTaskState(db: DatabaseSync, taskId: string): { state: string; reason: string } {
  const row = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task-state' ORDER BY seq DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (row === undefined) return { state: "READY", reason: "created" };
  try {
    const parsed = JSON.parse(row.payload) as { state?: unknown; reason?: unknown };
    if (typeof parsed.state === "string") {
      return { state: parsed.state, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
    }
  } catch {
    // Fall through to READY rather than crashing on a bad row.
  }
  return { state: "READY", reason: "created" };
}

// Upserts the contract document: every revision stays queryable through
// the events history while this row always holds the current revision.
export function persistContract(db: DatabaseSync, contract: TaskContract, now: Date = new Date()): void {
  db.prepare(
    "INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET revision = excluded.revision, document = excluded.document, updated_at = excluded.updated_at",
  ).run(contract.taskId, contract.rootId, contract.revision, JSON.stringify(contract), now.toISOString());
}

export function readContract(db: DatabaseSync, taskId: string): TaskContract | null {  const row = db.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as
    | { document: string }
    | undefined;
  if (row === undefined) return null;
  try {
    return JSON.parse(row.document) as TaskContract;
  } catch {
    return null;
  }
}

// Obligation satisfaction is an event, not a second source of truth: the
// contract lists obligations, satisfaction events retire them with evidence.
export function satisfyObligation(db: DatabaseSync, taskId: string, obligation: string, evidenceRef: string): void {
  recordTaskEvent(db, taskId, "obligation.satisfied", { obligation, evidenceRef });
}

export function pendingObligations(db: DatabaseSync, contract: TaskContract): string[] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'obligation.satisfied' ORDER BY seq ASC")
    .all(contract.taskId) as Array<{ payload: string }>;
  const satisfied = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as { obligation?: unknown };
      if (typeof parsed.obligation === "string") satisfied.add(parsed.obligation);
    } catch {
      // Skip unreadable rows; the obligation stays pending.
    }
  }
  return contract.obligations.filter((obligation) => !satisfied.has(obligation));
}

export interface UnknownSummary {
  attemptId: string;
  intentId: string;
  operation: string;
  target: string | null;
  reason: string;
  recordedAt: string;
}

export function unknownHistory(db: DatabaseSync, taskId: string): UnknownSummary[] {
  const rows = db
    .prepare(
      `SELECT a.attempt_id, a.intent_id, a.created_at, i.operation, i.target, i.state,
              (SELECT r.detail FROM receipts r WHERE r.attempt_id = a.attempt_id) AS receipt
       FROM attempts a JOIN intents i ON i.intent_id = a.intent_id
       WHERE i.task_id = ? AND (i.state = 'UNKNOWN' OR a.state = 'UNKNOWN')
       ORDER BY a.created_at ASC`,
    )
    .all(taskId) as Array<{
    attempt_id: string;
    intent_id: string;
    created_at: string;
    operation: string;
    target: string | null;
    state: string;
    receipt: string | null;
  }>;
  return rows.map((row) => {
    let reason = "effect uncertain; reconcile before retry";
    if (row.receipt !== null) {
      try {
        const parsed = JSON.parse(row.receipt) as { summary?: unknown };
        if (typeof parsed.summary === "string" && parsed.summary !== "") reason = parsed.summary;
      } catch {
        // Keep the default reason.
      }
    }
    return {
      attemptId: row.attempt_id,
      intentId: row.intent_id,
      operation: row.operation,
      target: row.target,
      reason,
      recordedAt: row.created_at,
    };
  });
}

export interface DriftEntry {
  path: string;
  change: "modified" | "deleted";
  lastObserved: string | null;
  current: string | null;
}

function contentVersion(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

interface ObservedFile {
  version: string;
}

// Recomputes content versions for every file the task observed through
// read/edit receipts and compares them with the workspace as found now.
// Files the task never touched are not drift: human work elsewhere is simply
// preserved, never reverted or blamed.
export function detectWorkspaceDrift(db: DatabaseSync, taskId: string, workspace: string): DriftEntry[] {
  const rows = db
    .prepare(
      `SELECT i.target, r.detail
       FROM attempts a JOIN intents i ON i.intent_id = a.intent_id
       LEFT JOIN receipts r ON r.attempt_id = a.attempt_id
       WHERE i.task_id = ? AND i.operation IN ('read', 'edit') AND i.target IS NOT NULL
       ORDER BY a.created_at ASC`,
    )
    .all(taskId) as Array<{ target: string | null; detail: string | null }>;
  const observed = new Map<string, ObservedFile>();
  for (const row of rows) {
    if (row.target === null) continue;
    const version = versionFromReceipt(row.detail);
    if (version !== null) observed.set(row.target, { version });
  }
  const drift: DriftEntry[] = [];
  for (const [target, { version }] of observed) {
    const absolute = path.resolve(workspace, target);
    const root = path.resolve(workspace);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(absolute);
    } catch {
      drift.push({ path: target, change: "deleted", lastObserved: version, current: null });
      continue;
    }
    const now = contentVersion(current);
    if (now !== version) {
      drift.push({ path: target, change: "modified", lastObserved: version, current: now });
    }
  }
  return drift;
}

function versionFromReceipt(detail: string | null): string | null {
  if (detail === null) return null;
  return receiptEffectVersions(detail).afterVersion;
}

export interface RunManifestView {
  provider: string;
  model: string;
  baseUrl: string | null;
  workspace: string;
}

// Latest run manifest for a task: the composition (provider/model/binding)
// a manual resume continues with. Resume-marker runs carry no composition,
// so the latest run whose manifest parses with a provider and model wins.
// Throws fail-closed when no usable composition exists.
export function readRunManifest(db: DatabaseSync, taskId: string): RunManifestView {
  const rows = db.prepare("SELECT manifest FROM runs WHERE task_id = ? ORDER BY created_at DESC").all(taskId) as
    | Array<{ manifest: string }>
    | undefined;
  if (rows !== undefined) {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.manifest);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record["provider"] !== "string" || typeof record["model"] !== "string") continue;
      return {
        provider: record["provider"],
        model: record["model"],
        baseUrl: typeof record["baseUrl"] === "string" ? record["baseUrl"] : null,
        workspace: typeof record["workspace"] === "string" ? record["workspace"] : "",
      };
    }
  }
  throw new Error(`no run composition for task ${taskId}`);
}

export interface ResumeBlocker {
  code: string;
  detail: string;
}

export interface ResumeReport {
  taskId: string;
  rootId: string;
  sessionId: string;
  newRunId: string | null;
  contractRevision: number;
  state: string;
  stateReason: string;
  generation: number;
  budget: {
    granted: { calls: number; tokens: number };
    reserved: { calls: number; tokens: number };
    settled: { calls: number; tokens: number };
  };
  expired: boolean;
  expiresAt: string;
  workspaceOk: boolean;
  workspaceDetail: string;
  unknowns: UnknownSummary[];
  invalidatedAdmissions: string[];
  waits: WaitRecord[];
  drift: DriftEntry[];
  staleEvidence: Array<{ path: string; reason: string }>;
  obligationsPending: string[];
  acceptanceCriteria: string[];
  verifications: Array<{ command: string; exitCode: number | null; passed: number | null; failed: number | null }>;
  humanDecisions: string[];
  compositionChanged: boolean;
  canResume: boolean;
  blockers: ResumeBlocker[];
}

export interface ResumeGateInput {
  taskId: string;
  generation: number;
  packageVersion: string;
  now?: Date | undefined;
}

export interface ResumeGateOptions {
  // False for hot read paths (snapshots during a live run): reports current
  // unknowns without invalidating in-flight admissions. True on real resume.
  classifyPending?: boolean | undefined;
}

// Validates continuity without executing anything: loads the persisted
// contract, manifest, budget, pending intents, UNKNOWN history and workspace
// drift, then classifies every unfinished intent. ADMITTED-without-claim is
// invalidated (it never dispatched); CLAIMED-without-receipt becomes UNKNOWN
// with an explicit quarantine reason when it supervised a process.
export function evaluateResumeGate(db: DatabaseSync, input: ResumeGateInput, options?: ResumeGateOptions): ResumeReport {
  const now = input.now ?? new Date();
  const contract = readContract(db, input.taskId);
  if (contract === null) {
    return blockedReport(input.taskId, [{ code: "no-contract", detail: `no usable contract for task ${input.taskId}; refusing resume` }]);
  }
  const manifestRow = db
    .prepare("SELECT manifest FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(input.taskId) as { manifest: string } | undefined;
  if (manifestRow === undefined) {
    return blockedReport(input.taskId, [{ code: "no-run", detail: `no run manifest for task ${input.taskId}; refusing resume` }]);
  }
  const { sessionId } = openSession(db, contract.rootId);
  const state = readTaskState(db, input.taskId);
  const granted = grantedFromContract(contract);
  const snapshot = taskBudgetSnapshot(db, input.taskId, granted);
  const expired = isContractExpired(contract, now);
  const blockers: ResumeBlocker[] = [];
  if (expired) {
    blockers.push({ code: "contract-expired", detail: `contract expired at ${contract.expiresAt}; a new grant is required before resuming` });
  }
  if (state.state === "COMPLETED" || state.state === "CANCELLED") {
    blockers.push({ code: "terminal-state", detail: `task is ${state.state}; resume applies to unfinished work, not to closed tasks` });
  }
  const workspace = contract.scope[0] ?? "";
  let workspaceOk = true;
  let workspaceDetail = workspace === "" ? "contract carries no workspace scope" : `workspace present: ${workspace}`;
  if (workspace !== "") {
    try {
      if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
        workspaceOk = false;
        workspaceDetail = `workspace missing or not a directory: ${workspace}`;
      }
    } catch {
      workspaceOk = false;
      workspaceDetail = `workspace not readable: ${workspace}`;
    }
  }
  if (!workspaceOk) {
    blockers.push({ code: "workspace-missing", detail: workspaceDetail });
  }

  const invalidatedAdmissions = options?.classifyPending === false ? [] : classifyUnfinishedIntents(db, input.taskId);
  const unknowns = unknownHistory(db, input.taskId);
  const drift = workspaceOk && workspace !== "" ? detectWorkspaceDrift(db, input.taskId, workspace) : [];
  const staleEvidence = drift.map((entry) => ({
    path: entry.path,
    reason: `content ${entry.change} since last observed version; prior evidence for this file is stale until re-verified`,
  }));
  const manifest = safeParseManifest(manifestRow.manifest);
  return {
    taskId: input.taskId,
    rootId: contract.rootId,
    sessionId,
    newRunId: null,
    contractRevision: contract.revision,
    state: state.state,
    stateReason: state.reason,
    generation: input.generation,
    budget: {
      granted: { ...granted },
      reserved: { ...snapshot.reserved },
      settled: { ...snapshot.settled },
    },
    expired,
    expiresAt: contract.expiresAt,
    workspaceOk,
    workspaceDetail,
    unknowns,
    invalidatedAdmissions,
    waits: listActiveWaits(db, input.taskId),
    drift,
    staleEvidence,
    obligationsPending: pendingObligations(db, contract),
    acceptanceCriteria: [...contract.acceptanceCriteria],
    verifications: readVerifications(db, input.taskId),
    humanDecisions: readHumanDecisions(db, input.taskId),
    compositionChanged: manifest.packageVersion !== null && manifest.packageVersion !== input.packageVersion,
    canResume: blockers.length === 0,
    blockers,
  };
}

// Classifies unfinished intents durably. Returns invalidated ADMITTED intent
// ids. CLAIMED-without-receipt attempts are indistinguishable from
// post-invocation crashes, so they become UNKNOWN; supervised-process intents
// carry an explicit quarantine reason because fresh generations never adopt
// old handles or kill by bare PID.
function classifyUnfinishedIntents(db: DatabaseSync, taskId: string): string[] {
  const rows = db
    .prepare("SELECT intent_id, state, operation FROM intents WHERE task_id = ? AND state IN ('ADMITTED', 'CLAIMED')")
    .all(taskId) as Array<{ intent_id: string; state: string; operation: string }>;
  const invalidated: string[] = [];
  for (const row of rows) {
    if (row.state === "ADMITTED") {
      if (invalidateAdmittedIntent(db, row.intent_id)) invalidated.push(row.intent_id);
      continue;
    }
    quarantineClaimed(db, taskId, row.intent_id, row.operation);
  }
  return invalidated;
}

function quarantineClaimed(db: DatabaseSync, taskId: string, intentId: string, operation: string): void {
  const reason =
    operation === "exec" || operation === "process"
      ? "owner restarted; supervised handles never transfer generations: process left untouched, classified UNKNOWN until observed"
      : "claim without receipt after restart; effect uncertain until reconciled";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE intents SET state = 'UNKNOWN' WHERE intent_id = ? AND state = 'CLAIMED'").run(intentId);
    db.prepare("UPDATE attempts SET state = 'UNKNOWN' WHERE intent_id = ? AND state = 'CLAIMED'").run(intentId);
    db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
      "unknown.classified",
      taskId,
      JSON.stringify({ intentId, reason }),
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
}

function safeParseManifest(manifestJson: string): { packageVersion: string | null } {
  try {
    const parsed = JSON.parse(manifestJson) as { packageVersion?: unknown };
    return { packageVersion: typeof parsed.packageVersion === "string" ? parsed.packageVersion : null };
  } catch {
    return { packageVersion: null };
  }
}

function readVerifications(db: DatabaseSync, taskId: string): ResumeReport["verifications"] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'verification' ORDER BY seq ASC LIMIT 100")
    .all(taskId) as Array<{ payload: string }>;
  const out: ResumeReport["verifications"] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      out.push({
        command: typeof parsed["command"] === "string" ? parsed["command"] : "unknown",
        exitCode: typeof parsed["exitCode"] === "number" ? parsed["exitCode"] : null,
        passed: typeof parsed["passed"] === "number" ? parsed["passed"] : null,
        failed: typeof parsed["failed"] === "number" ? parsed["failed"] : null,
      });
    } catch {
      // Skip unreadable rows.
    }
  }
  return out;
}

function readHumanDecisions(db: DatabaseSync, taskId: string): string[] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind IN ('steering', 'steering-applied') ORDER BY seq ASC LIMIT 100")
    .all(taskId) as Array<{ payload: string }>;
  const decisions: string[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as { text?: unknown; id?: unknown };
      if (typeof parsed.text === "string") decisions.push(parsed.text);
      else if (typeof parsed.id === "string") decisions.push(`steering ${parsed.id} applied`);
    } catch {
      // Skip unreadable rows.
    }
  }
  return decisions;
}

function blockedReport(taskId: string, blockers: ResumeBlocker[]): ResumeReport {
  return {
    taskId,
    rootId: "",
    sessionId: "",
    newRunId: null,
    contractRevision: 0,
    state: "BLOCKED",
    stateReason: blockers[0]?.detail ?? "resume refused",
    generation: 0,
    budget: {
      granted: { calls: 0, tokens: 0 },
      reserved: { calls: 0, tokens: 0 },
      settled: { calls: 0, tokens: 0 },
    },
    expired: false,
    expiresAt: "",
    workspaceOk: false,
    workspaceDetail: "",
    unknowns: [],
    invalidatedAdmissions: [],
    waits: [],
    drift: [],
    staleEvidence: [],
    obligationsPending: [],
    acceptanceCriteria: [],
    verifications: [],
    humanDecisions: [],
    compositionChanged: false,
    canResume: false,
    blockers,
  };
}

// Manual resume: evaluates the gate and, only when it allows, opens a new
// run under the same session/root and moves a crash-interrupted RUNNING task
// back to READY. Viewing history never resumes; this function is the explicit
// action. It never invokes tools or the model.
export function resumeTask(db: DatabaseSync, input: ResumeGateInput & { manifestExtra?: Record<string, unknown> }): ResumeReport {
  const report = evaluateResumeGate(db, input);
  if (!report.canResume) return report;
  const newRunId = openRun(
    db,
    {
      sessionId: report.sessionId,
      rootId: report.rootId,
      taskId: report.taskId,
      manifest: { resumedFromState: report.state, resumedAt: new Date().toISOString(), ...(input.manifestExtra ?? {}) },
    },
  );
  if (report.state === "RUNNING") {
    recordTaskEvent(db, report.taskId, "task-state", {
      state: "READY",
      reason: "manual resume after restart; unfinished intents classified, no effect replayed",
    });
    report.state = "READY";
    report.stateReason = "manual resume after restart; unfinished intents classified, no effect replayed";
  }
  recordTaskEvent(db, report.taskId, "resume", { runId: newRunId, generation: input.generation });
  report.newRunId = newRunId;
  return report;
}
