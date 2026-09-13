import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  admitIntent,
  claimTicket,
  type ActionIntent,
  type AdmissionTicket,
} from "./admission.js";
import { BudgetExceededError, BudgetLedger } from "./budget.js";
import { guardWrites, throwIfFault } from "./faults.js";
import type { TaskContract } from "./contract.js";

export interface DurableIntentInput {
  taskId: string;
  operation: string;
  target: string | null;
  actionKey: string;
  authorityRevision: number;
  maxCalls: number;
  maxTokens: number;
  argsJson: string;
  // Logical model request this intent belongs to, when the intent is a
  // cognitive dispatch. Persisted so the usage ledger can group retries.
  requestId?: string | undefined;
}

export type DurableDenialReason =
  | "no-grant"
  | "contract-expired"
  | "stale-revision"
  | "stale-generation"
  | "budget-exceeded"
  | "duplicate-pending";

export interface DurableAdmitted {
  admitted: true;
  intentId: string;
  attemptId: string;
  ticket: AdmissionTicket;
}

export interface DurableDenied {
  admitted: false;
  reason: DurableDenialReason;
  detail: string;
}

export type DurableAdmission = DurableAdmitted | DurableDenied;

export type DurableClaimResult =
  | { claimed: true }
  | { claimed: false; reason: "already-claimed" | "stale-generation" | "stale-revision" | "not-found" | "invalidated" };

export class DuplicateReceiptError extends Error {
  readonly attemptId: string;
  constructor(attemptId: string) {
    super(`Receipt for attempt ${attemptId} already recorded; settlement happens once`);
    this.name = "DuplicateReceiptError";
    this.attemptId = attemptId;
  }
}

export type ReceiptOutcome = "confirmed" | "failed" | "unknown";

export interface ReceiptInput {
  attemptId: string;
  outcome: ReceiptOutcome;
  summary: string;
  detailJson: string;
  settledCalls: number;
  settledTokens: number;
  // When usage is unknown, the token ceiling stays reserved instead of being
  // released: absence of usage is not zero. A later correction releases it.
  releaseUnused?: boolean;
}

interface ReservationTotals {
  calls: number;
  tokens: number;
}

function openReservationTotals(db: DatabaseSync, taskId: string): ReservationTotals {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(calls - settled_calls), 0) AS calls,
              COALESCE(SUM(tokens - settled_tokens), 0) AS tokens
       FROM reservations WHERE state = 'open' AND intent_id IN
         (SELECT intent_id FROM intents WHERE task_id = ?)`,
    )
    .get(taskId) as { calls: number; tokens: number };
  return { calls: row.calls, tokens: row.tokens };
}

function settledTotals(db: DatabaseSync, taskId: string): ReservationTotals {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(settled_calls), 0) AS calls,
              COALESCE(SUM(settled_tokens), 0) AS tokens
       FROM reservations WHERE intent_id IN
         (SELECT intent_id FROM intents WHERE task_id = ?)`,
    )
    .get(taskId) as { calls: number; tokens: number };
  return { calls: row.calls, tokens: row.tokens };
}

export function taskBudgetSnapshot(
  db: DatabaseSync,
  taskId: string,
  granted: { calls: number; tokens: number },
): { granted: { calls: number; tokens: number }; reserved: ReservationTotals; settled: ReservationTotals } {
  return {
    granted: { ...granted },
    reserved: openReservationTotals(db, taskId),
    settled: settledTotals(db, taskId),
  };
}

function findDuplicateUnknown(db: DatabaseSync, taskId: string, actionKey: string): string | null {
  const row = db
    .prepare(
      `SELECT intent_id FROM intents
       WHERE task_id = ? AND action_key = ? AND state IN ('ADMITTED', 'CLAIMED', 'UNKNOWN')`,
    )
    .get(taskId, actionKey) as { intent_id: string } | undefined;
  return row?.intent_id ?? null;
}

// Durable admission: revalidates contract authority, checks the persisted
// budget (settled + reserved <= granted across restarts), guards against
// silently duplicating a pending/UNKNOWN equivalent intent, then commits the
// intent, attempt and reservation in one transaction. A commit failure means
// no dispatch is authorized.
export function admitDurable(
  db: DatabaseSync,
  contract: TaskContract,
  input: DurableIntentInput,
  granted: { calls: number; tokens: number },
  ownerGeneration: number,
  now: Date = new Date(),
): DurableAdmission {
  const actionIntent: ActionIntent = {
    intentId: `intent-${randomUUID()}`,
    operation: input.operation,
    target: input.target,
    actionKey: input.actionKey,
    authorityRevision: input.authorityRevision,
    maxCalls: input.maxCalls,
    maxTokens: input.maxTokens,
  };
  const reserved = openReservationTotals(db, input.taskId);
  const settled = settledTotals(db, input.taskId);
  if (
    settled.calls + reserved.calls + input.maxCalls > granted.calls ||
    settled.tokens + reserved.tokens + input.maxTokens > granted.tokens
  ) {
    return {
      admitted: false,
      reason: "budget-exceeded",
      detail: "Reservation would exceed granted budget (settled + reserved <= granted)",
    };
  }
  const duplicate = findDuplicateUnknown(db, input.taskId, input.actionKey);
  if (duplicate !== null) {
    return {
      admitted: false,
      reason: "duplicate-pending",
      detail: `Equivalent intent ${duplicate} is already pending or UNKNOWN; reconcile before duplicating`,
    };
  }
  const attemptId = `attempt-${randomUUID()}`;
  const check = admitIntent({
    intent: actionIntent,
    contract,
    ledger: ledgerWithPersistedTotals(granted, settled, reserved),
    ownerGeneration,
    now,
  });
  if (!check.admitted) {
    return { admitted: false, reason: check.reason, detail: check.detail };
  }
  const createdAt = now.toISOString();
  guardWrites("admitDurable");
  throwIfFault("before-admitted-commit");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO intents (intent_id, task_id, operation, target, action_key, authority_revision, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ADMITTED', ?)`,
    ).run(
      actionIntent.intentId,
      input.taskId,
      input.operation,
      input.target,
      input.actionKey,
      input.authorityRevision,
      createdAt,
    );
    db.prepare(
      `INSERT INTO attempts (attempt_id, intent_id, request_id, generation, ticket, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'ADMITTED', ?)`,
    ).run(
      attemptId,
      actionIntent.intentId,
      input.requestId ?? null,
      ownerGeneration,
      JSON.stringify({ ...check.ticket, args: input.argsJson }),
      createdAt,
    );
    db.prepare(
      `INSERT INTO reservations (intent_id, calls, tokens, settled_calls, settled_tokens, state)
       VALUES (?, ?, ?, 0, 0, 'open')`,
    ).run(actionIntent.intentId, input.maxCalls, input.maxTokens);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
  throwIfFault("after-admitted");
  return { admitted: true, intentId: actionIntent.intentId, attemptId, ticket: check.ticket };
}

// Reuses the S0 validation (grant, expiry, revision, generation) against
// totals already persisted, so restarts never renew the budget.
function ledgerWithPersistedTotals(
  granted: { calls: number; tokens: number },
  settled: ReservationTotals,
  reserved: ReservationTotals,
): BudgetLedger {
  const ledger = new BudgetLedger(granted);
  if (settled.calls > 0 || settled.tokens > 0) {
    ledger.reserve({ calls: settled.calls, tokens: settled.tokens });
    ledger.settle(`persisted-${settled.calls}-${settled.tokens}`, {
      calls: settled.calls,
      tokens: settled.tokens,
    });
  }
  ledger.reserve(reserved);
  return ledger;
}

// Durable claim: revalidates generation and contract revision against the
// persisted ticket immediately before invocation, single-use. Commit durável;
// the executor may invoke at most once after this commit.
export function claimDurable(
  db: DatabaseSync,
  attemptId: string,
  ownerGeneration: number,
  contractRevision: number,
): DurableClaimResult {
  const row = db
    .prepare("SELECT ticket, state FROM attempts WHERE attempt_id = ?")
    .get(attemptId) as { ticket: string; state: string } | undefined;
  if (row === undefined) return { claimed: false, reason: "not-found" };
  // Only a live admission ticket is claimable: resolved, unknown,
  // reconciled and invalidated attempts never gain authority again, even if
  // a concurrent reader classified them between admission and claim.
  if (row.state === "INVALIDATED") return { claimed: false, reason: "invalidated" };
  if (row.state !== "ADMITTED") return { claimed: false, reason: "already-claimed" };
  const ticket = JSON.parse(row.ticket) as AdmissionTicket;
  const result = claimTicket(ticket, ownerGeneration, contractRevision);
  if (!result.claimed) {
    return { claimed: false, reason: result.reason ?? "already-claimed" };
  }
  guardWrites("claimDurable");
  throwIfFault("before-claim-commit");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE attempts SET state = 'CLAIMED' WHERE attempt_id = ?").run(attemptId);
    db.prepare("UPDATE intents SET state = 'CLAIMED' WHERE intent_id = (SELECT intent_id FROM attempts WHERE attempt_id = ?)").run(
      attemptId,
    );
    db.prepare("UPDATE attempts SET ticket = ? WHERE attempt_id = ?").run(
      JSON.stringify({ ...ticket, claimed: true }),
      attemptId,
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
  throwIfFault("after-claim");
  return { claimed: true };
}

// Invalidates an ADMITTED intent that was never claimed (crash boundary B):
// by protocol it never dispatched, so the ticket dies and the unused
// reservation is released. Readmission stays possible when still needed.
export function invalidateAdmittedIntent(db: DatabaseSync, intentId: string): boolean {
  guardWrites("invalidateAdmittedIntent");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare("SELECT state FROM intents WHERE intent_id = ?")
      .get(intentId) as { state: string } | undefined;
    if (row === undefined || row.state !== "ADMITTED") {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("UPDATE intents SET state = 'INVALIDATED' WHERE intent_id = ?").run(intentId);
    db.prepare("UPDATE attempts SET state = 'INVALIDATED' WHERE intent_id = ? AND state = 'ADMITTED'").run(intentId);
    db.prepare("UPDATE reservations SET calls = settled_calls, tokens = settled_tokens, state = 'closed' WHERE intent_id = ?").run(
      intentId,
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
  return true;
}

// Durable receipt: persists the observed outcome, settles the reservation
// idempotently per attempt and closes the attempt in one transaction.
// UNKNOWN keeps the attempt pending reconciliation; it never replays blind.
export function recordReceiptDurable(db: DatabaseSync, input: ReceiptInput, now: Date = new Date()): void {
  const row = db
    .prepare("SELECT intent_id, state FROM attempts WHERE attempt_id = ?")
    .get(input.attemptId) as { intent_id: string; state: string } | undefined;
  if (row === undefined) {
    throw new Error(`Attempt ${input.attemptId} not found; cannot record receipt`);
  }
  if (row.state === "RESOLVED") {
    throw new DuplicateReceiptError(input.attemptId);
  }
  const createdAt = now.toISOString();
  guardWrites("recordReceiptDurable");
  throwIfFault("before-receipt-commit");
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM receipts WHERE attempt_id = ?")
      .get(input.attemptId) as { n: number };
    if (existing.n > 0) {
      throw new DuplicateReceiptError(input.attemptId);
    }
    db.prepare(
      `INSERT INTO receipts (receipt_id, attempt_id, outcome, detail, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      `receipt-${randomUUID()}`,
      input.attemptId,
      input.outcome,
      JSON.stringify({ summary: input.summary, detail: input.detailJson }),
      createdAt,
    );
    const reservation = db
      .prepare("SELECT calls, tokens, settled_calls, settled_tokens FROM reservations WHERE intent_id = ?")
      .get(row.intent_id) as
      | { calls: number; tokens: number; settled_calls: number; settled_tokens: number }
      | undefined;
    if (reservation === undefined) {
      throw new Error(`Reservation for intent ${row.intent_id} not found`);
    }
    const openCalls = reservation.calls - reservation.settled_calls;
    const openTokens = reservation.tokens - reservation.settled_tokens;
    if (input.settledCalls > openCalls || input.settledTokens > openTokens) {
      throw new BudgetExceededError("settlement exceeding reservation");
    }
    const releaseUnused = input.releaseUnused ?? true;
    const releasedCalls = releaseUnused ? openCalls - input.settledCalls : 0;
    const releasedTokens = releaseUnused ? openTokens - input.settledTokens : 0;
    db.prepare(
      `UPDATE reservations SET calls = calls - ?, tokens = tokens - ?,
        settled_calls = settled_calls + ?, settled_tokens = settled_tokens + ?
       WHERE intent_id = ?`,
    ).run(releasedCalls, releasedTokens, input.settledCalls, input.settledTokens, row.intent_id);
    db.prepare(
      `UPDATE reservations SET state = CASE
         WHEN (calls - settled_calls) + (tokens - settled_tokens) > 0 THEN 'open'
         ELSE 'closed' END
       WHERE intent_id = ?`,
    ).run(row.intent_id);
    const attemptState = input.outcome === "unknown" ? "UNKNOWN" : "RESOLVED";
    db.prepare("UPDATE attempts SET state = ? WHERE attempt_id = ?").run(attemptState, input.attemptId);
    db.prepare("UPDATE intents SET state = ? WHERE intent_id = ?").run(
      input.outcome === "unknown" ? "UNKNOWN" : "RESOLVED",
      row.intent_id,
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

// Recovery scan: CLAIMED attempts without a receipt are indistinguishable
// from post-invocation crashes, so they surface as UNKNOWN candidates.
export function findUnreconciledAttempts(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT attempt_id FROM attempts WHERE state = 'CLAIMED'
       AND attempt_id NOT IN (SELECT attempt_id FROM receipts)`,
    )
    .all() as Array<{ attempt_id: string }>;
  return rows.map((row) => row.attempt_id);
}

// Late usage evidence: a new revision for the same physical attempt. Never
// a second settlement by itself; settlement corrections are explicit. Object
// documents are stamped with their revision so every stored revision stays
// self-describing for the export projection.
export function recordUsageRevision(db: DatabaseSync, attemptId: string, documentJson: string, now: Date = new Date()): number {
  const row = db
    .prepare("SELECT revision FROM attempt_usage WHERE attempt_id = ?")
    .get(attemptId) as { revision: number } | undefined;
  const revision = (row?.revision ?? 0) + 1;
  db.prepare(
    `INSERT INTO attempt_usage (attempt_id, revision, document, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET revision = excluded.revision, document = excluded.document, updated_at = excluded.updated_at`,
  ).run(attemptId, revision, stampRevision(documentJson, revision), now.toISOString());
  return revision;
}

function stampRevision(documentJson: string, revision: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson);
  } catch {
    return documentJson;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return documentJson;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), usageRevision: revision });
}

// Releases whatever a reservation still holds open (for example after late
// usage arrived and was accounted). Closed reservations stay closed.
export function releaseReservation(db: DatabaseSync, intentId: string): void {
  db.prepare(
    `UPDATE reservations SET calls = settled_calls, tokens = settled_tokens, state = 'closed'
     WHERE intent_id = ? AND state = 'open'`,
  ).run(intentId);
}

export type EditReconciliation =
  | { result: "applied"; detail: string }
  | { result: "not-applied"; detail: string }
  | { result: "conflict"; detail: string };

// Extracts the post-effect content version from a receipt detail envelope.
// Accepts the normalized top-level afterVersion/version as well as older
// shapes where versions only appear nested inside the raw output blob.
export function receiptEffectVersions(receiptDetail: string): { afterVersion: string | null } {
  try {
    const outer = JSON.parse(receiptDetail) as { detail?: unknown };
    const candidates: unknown[] = [];
    if (typeof outer.detail === "string") {
      try {
        const inner = JSON.parse(outer.detail) as Record<string, unknown>;
        candidates.push(inner);
        if (typeof inner.output === "string") {
          try {
            candidates.push(JSON.parse(inner.output) as Record<string, unknown>);
          } catch {
            // Raw output is not JSON; versions must be top-level.
          }
        }
      } catch {
        return { afterVersion: null };
      }
    }
    for (const candidate of candidates) {
      if (candidate !== null && typeof candidate === "object") {
        const record = candidate as Record<string, unknown>;
        if (typeof record["afterVersion"] === "string") return { afterVersion: record["afterVersion"] };
        if (typeof record["version"] === "string") return { afterVersion: record["version"] };
      }
    }
    return { afterVersion: null };
  } catch {
    return { afterVersion: null };
  }
}

// Reconciles an UNKNOWN edit without replaying it: compares the observed
// content version against the versions retained before the write. Same final
// hash proves the desired state, not authorship; anything else is conflict.
//
// Reconciliation evidence is a new event, never a second receipt: the
// UNKNOWN receipt stays as history. Applied and not-applied outcomes move
// the intent to RECONCILED, which lifts the duplicate guard for an explicit
// readmission; conflict keeps UNKNOWN blocking until a human decides.
export function reconcileEditAttempt(
  db: DatabaseSync,
  attemptId: string,
  observedVersion: string,
): EditReconciliation {
  const row = db
    .prepare("SELECT intent_id, ticket FROM attempts WHERE attempt_id = ?")
    .get(attemptId) as { intent_id: string; ticket: string } | undefined;
  if (row === undefined) {
    return { result: "conflict", detail: `attempt ${attemptId} not found; cannot reconcile` };
  }
  const ticket = JSON.parse(row.ticket) as { args?: string };
  let args: { expectedVersion?: string };
  try {
    args = ticket.args !== undefined ? (JSON.parse(ticket.args) as { expectedVersion?: string }) : {};
  } catch {
    return { result: "conflict", detail: `attempt ${attemptId} carries no parseable edit plan` };
  }
  const receipt = db
    .prepare("SELECT detail FROM receipts WHERE attempt_id = ?")
    .get(attemptId) as { detail: string } | undefined;
  const afterVersion = receipt !== undefined ? receiptEffectVersions(receipt.detail).afterVersion : null;
  if (afterVersion !== null && observedVersion === afterVersion) {
    closeReconciliation(db, row.intent_id, attemptId, "applied", `effect present at ${observedVersion}`);
    return { result: "applied", detail: `effect present at ${observedVersion}` };
  }
  if (args.expectedVersion !== undefined && observedVersion === args.expectedVersion) {
    closeReconciliation(db, row.intent_id, attemptId, "not-applied", `no effect at ${observedVersion}; safe to readmit`);
    return { result: "not-applied", detail: `no effect at ${observedVersion}; safe to readmit` };
  }
  db.prepare(`INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)`).run(
    "reconciliation.conflict",
    null,
    JSON.stringify({ attemptId, observedVersion }),
    new Date().toISOString(),
  );
  return {
    result: "conflict",
    detail: `current content ${observedVersion} matches neither before nor after version; human decision required`,
  };
}

function closeReconciliation(
  db: DatabaseSync,
  intentId: string,
  attemptId: string,
  result: "applied" | "not-applied",
  detail: string,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)`).run(
      `reconciliation.${result}`,
      null,
      JSON.stringify({ attemptId, detail }),
      new Date().toISOString(),
    );
    db.prepare(`UPDATE intents SET state = 'RECONCILED' WHERE intent_id = ?`).run(intentId);
    db.prepare(`UPDATE attempts SET state = 'RECONCILED' WHERE attempt_id = ?`).run(attemptId);
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
