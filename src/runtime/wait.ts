import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { guardWrites, throwIfFault } from "./faults.js";

// Minimal WAIT: durable wait records plus a deterministic WakeGate. Waiting
// never invokes the model: these primitives only read and write coordination
// state. Wakes arrive from explicit observations (process probe, human input,
// deadline check, manual resume) delivered by the caller. Nothing here polls
// the network, schedules work, or survives the app being closed: a shutdown
// app does not wake.

export type WaitKind = "process" | "input" | "deadline" | "manual";
export type WaitState = "active" | "fired" | "consumed" | "cancelled";

export interface WaitRequest {
  kind: WaitKind;
  condition: string;
  source: string;
  observedCursor: string;
  obligation: string;
  deadline?: string | undefined;
}

export interface WaitRecord extends WaitRequest {
  waitId: string;
  taskId: string;
  state: WaitState;
  createdAt: string;
  updatedAt: string;
}

function waitIdFor(taskId: string, request: WaitRequest): string {
  return `wait-${createHash("sha256").update(`${taskId}|${request.kind}|${request.condition}|${request.source}`, "utf8").digest("hex").slice(0, 16)}`;
}

// Idempotent entry: re-entering the same condition returns the existing wait
// instead of duplicating it. Never touches the model.
export function enterWait(db: DatabaseSync, taskId: string, request: WaitRequest, now: Date = new Date()): { waitId: string; created: boolean } {
  guardWrites("enterWait");
  const waitId = waitIdFor(taskId, request);
  const existing = db.prepare("SELECT state FROM waits WHERE wait_id = ?").get(waitId) as
    | { state: string }
    | undefined;
  if (existing !== undefined && existing.state !== "cancelled") {
    return { waitId, created: false };
  }
  const at = now.toISOString();
  db.prepare(
    `INSERT INTO waits (wait_id, task_id, kind, condition, source, observed_cursor, obligation, deadline, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(wait_id) DO UPDATE SET kind = excluded.kind, condition = excluded.condition,
       source = excluded.source, observed_cursor = excluded.observed_cursor, obligation = excluded.obligation,
       deadline = excluded.deadline, state = 'active', updated_at = excluded.updated_at`,
  ).run(
    waitId,
    taskId,
    request.kind,
    request.condition,
    request.source,
    request.observedCursor,
    request.obligation,
    request.deadline ?? null,
    at,
    at,
  );
  db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
    "wait.entered",
    taskId,
    JSON.stringify({ waitId, kind: request.kind, condition: request.condition, obligation: request.obligation }),
    at,
  );
  return { waitId, created: true };
}

export function listActiveWaits(db: DatabaseSync, taskId: string): WaitRecord[] {  const rows = db
    .prepare("SELECT * FROM waits WHERE task_id = ? AND state = 'active' ORDER BY created_at ASC")
    .all(taskId) as Array<{
    wait_id: string;
    task_id: string;
    kind: WaitKind;
    condition: string;
    source: string;
    observed_cursor: string;
    obligation: string;
    deadline: string | null;
    state: WaitState;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map(toRecord);
}

export function listFiredWaits(db: DatabaseSync, taskId: string): WaitRecord[] {
  const rows = db
    .prepare("SELECT * FROM waits WHERE task_id = ? AND state = 'fired' ORDER BY updated_at ASC")
    .all(taskId) as Array<{
    wait_id: string;
    task_id: string;
    kind: WaitKind;
    condition: string;
    source: string;
    observed_cursor: string;
    obligation: string;
    deadline: string | null;
    state: WaitState;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map(toRecord);
}

export function cancelActiveWaits(db: DatabaseSync, taskId: string, reason: string): string[] {
  guardWrites("cancelActiveWaits");
  const active = listActiveWaits(db, taskId);
  const at = new Date().toISOString();
  for (const wait of active) {
    db.prepare("UPDATE waits SET state = 'cancelled', updated_at = ? WHERE wait_id = ?").run(at, wait.waitId);
    db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
      "wait.cancelled",
      taskId,
      JSON.stringify({ waitId: wait.waitId, reason }),
      at,
    );
  }
  return active.map((wait) => wait.waitId);
}

interface WaitRow {
  wait_id: string;
  task_id: string;
  kind: WaitKind;
  condition: string;
  source: string;
  observed_cursor: string;
  obligation: string;
  deadline: string | null;
  state: WaitState;
  created_at: string;
  updated_at: string;
}

function toRecord(row: WaitRow): WaitRecord {
  return {
    waitId: row.wait_id,
    taskId: row.task_id,
    kind: row.kind,
    condition: row.condition,
    source: row.source,
    observedCursor: row.observed_cursor,
    obligation: row.obligation,
    ...(row.deadline !== null ? { deadline: row.deadline } : {}),
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface WakeInput {
  // Stable identity for level observations (source + cursor); caller-supplied
  // unique id for edge events (input, approval, revocation). Redelivery of
  // the same id is a duplicate, never a second activation.
  wakeId: string;
  waitId?: string | undefined;
  edge: boolean;
  source: string;
  cursor: string;
  observation: string;
  obligation?: string | undefined;
}

export type WakeResult =
  | { duplicate: true }
  | { duplicate: false; waitId: string | null; fired: boolean };

// Deterministic WakeGate: deduplicates by wake id, then persists the
// observation, the preserved obligation and the advanced cursor in one
// transaction before acknowledging. A commit failure leaves no ACK behind:
// the cursor never advances without durable representation.
export function recordWake(db: DatabaseSync, taskId: string, wake: WakeInput, now: Date = new Date()): WakeResult {
  guardWrites("recordWake");
  throwIfFault("before-cursor-commit");
  const at = now.toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT wake_id FROM wake_events WHERE wake_id = ?").get(wake.wakeId) as
      | { wake_id: string }
      | undefined;
    if (existing !== undefined) {
      db.exec("ROLLBACK");
      return { duplicate: true };
    }
    db.prepare(
      "INSERT INTO wake_events (wake_id, task_id, wait_id, edge, observation, received_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(wake.wakeId, taskId, wake.waitId ?? null, wake.edge ? 1 : 0, wake.observation, at);
    db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
      "wake.observed",
      taskId,
      JSON.stringify({ wakeId: wake.wakeId, waitId: wake.waitId ?? null, source: wake.source, cursor: wake.cursor, edge: wake.edge }),
      at,
    );
    let fired = false;
    if (wake.waitId !== undefined) {
      const target = db.prepare("SELECT state FROM waits WHERE wait_id = ? AND task_id = ?").get(wake.waitId, taskId) as
        | { state: string }
        | undefined;
      if (target !== undefined && target.state === "active") {
        db.prepare("UPDATE waits SET observed_cursor = ?, state = 'fired', updated_at = ? WHERE wait_id = ?").run(
          wake.cursor,
          at,
          wake.waitId,
        );
        if (wake.obligation !== undefined) {
          db.prepare("UPDATE waits SET obligation = ? WHERE wait_id = ?").run(wake.obligation, wake.waitId);
        }
        fired = true;
      }
    }
    db.exec("COMMIT");
    return { duplicate: false, waitId: wake.waitId ?? null, fired };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
}

// Consumes a fired wait at a safe point: marks it consumed and returns the
// latest observation so the loop can continue with evidence. One activation
// per task: a consumed wait never fires twice.
export function consumeFiredWait(db: DatabaseSync, taskId: string, waitId: string): { observation: string } | null {
  guardWrites("consumeFiredWait");
  const at = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const target = db.prepare("SELECT state FROM waits WHERE wait_id = ? AND task_id = ?").get(waitId, taskId) as
      | { state: string }
      | undefined;
    if (target === undefined || target.state !== "fired") {
      db.exec("ROLLBACK");
      return null;
    }
    const wake = db
      .prepare("SELECT observation FROM wake_events WHERE wait_id = ? ORDER BY received_at DESC LIMIT 1")
      .get(waitId) as { observation: string } | undefined;
    db.prepare("UPDATE waits SET state = 'consumed', updated_at = ? WHERE wait_id = ?").run(at, waitId);
    db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
      "wake.consumed",
      taskId,
      JSON.stringify({ waitId }),
      at,
    );
    db.exec("COMMIT");
    return { observation: wake?.observation ?? "" };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
}

// Level wakes carry a stable id derived from what was observed; edge events
// (input, approval, revocation) must never coalesce, so each carries a fresh
// unique id from the caller.
export function levelWakeId(taskId: string, source: string, cursor: string): string {
  return `wake-${createHash("sha256").update(`${taskId}|${source}|${cursor}`, "utf8").digest("hex").slice(0, 16)}`;
}

export function edgeWakeId(): string {
  return `wake-${randomUUID()}`;
}

// Deadline check is explicit and caller-driven: there is no background
// scheduler. Returns active waits whose deadline passed; the caller fires
// each through recordWake so dedup and cursor rules apply uniformly.
export function dueWaits(db: DatabaseSync, now: Date = new Date()): WaitRecord[] {
  const stamp = now.toISOString();
  const rows = db
    .prepare("SELECT * FROM waits WHERE state = 'active' AND deadline IS NOT NULL AND deadline <= ? ORDER BY created_at ASC")
    .all(stamp) as Array<{
    wait_id: string;
    task_id: string;
    kind: WaitKind;
    condition: string;
    source: string;
    observed_cursor: string;
    obligation: string;
    deadline: string | null;
    state: WaitState;
    created_at: string;
    updated_at: string;
  }>;
  return rows.map(toRecord);
}

// Revisions arriving while a task is active are persisted, never dropped and
// never applied mid-step. The loop takes them at a safe point, revalidates,
// and either applies or explains. Durable take: taken revisions are deleted
// in the same transaction that returns them.
export function notePendingRevision(db: DatabaseSync, taskId: string, revision: number, payload: Record<string, unknown>): void {
  guardWrites("notePendingRevision");
  db.prepare(
    "INSERT INTO pending_revisions (task_id, revision, payload, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(task_id, revision) DO NOTHING",
  ).run(taskId, revision, JSON.stringify(payload), new Date().toISOString());
}

export function takePendingRevisions(db: DatabaseSync, taskId: string): Array<{ revision: number; payload: Record<string, unknown> }> {  guardWrites("takePendingRevisions");
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db
      .prepare("SELECT revision, payload FROM pending_revisions WHERE task_id = ? ORDER BY revision ASC")
      .all(taskId) as Array<{ revision: number; payload: string }>;
    const out: Array<{ revision: number; payload: Record<string, unknown> }> = [];
    for (const row of rows) {
      try {
        out.push({ revision: row.revision, payload: JSON.parse(row.payload) as Record<string, unknown> });
      } catch {
        out.push({ revision: row.revision, payload: {} });
      }
    }
    db.prepare("DELETE FROM pending_revisions WHERE task_id = ?").run(taskId);
    db.exec("COMMIT");
    return out;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
}

// Deterministic process probe behind the loop waiter: a zero-timeout poll
// observes without blocking. Implemented by the caller (CLI/server) over the
// live supervisor; the waiter never touches OS processes itself.
export interface ProcessProbe {
  pollProcess(handle: string): Promise<
    | { running: true }
    | { running: false; observation: string }
    | { lost: true; reason: string }
  >;
}

// Production wait policy shared by CLI and server. Each check, in order:
// fires due deadlines through the WakeGate, consumes any fired wait into a
// wake, probes known supervised handles, and pauses on the first still
// running process. No background threads, no polling loops, no model calls:
// every observation is an explicit, durable wake.
export class HandleWaiter {
  private readonly handles = new Set<string>();
  private readonly db: DatabaseSync;
  private readonly taskId: string;
  private readonly probe: ProcessProbe;
  private readonly obligation: string;

  constructor(db: DatabaseSync, taskId: string, probe: ProcessProbe, obligation: string) {
    this.db = db;
    this.taskId = taskId;
    this.probe = probe;
    this.obligation = obligation;
  }

  noteToolEnd(tool: string, _status: string, handle: string | undefined): void {
    if ((tool === "exec" || tool === "process") && handle !== undefined) {
      this.handles.add(handle);
    }
  }

  // Sync fast path first: firing due deadlines and consuming fired waits
  // are synchronous DB work. The async probe runs only when supervised
  // handles actually need observation, so iterations without handles never
  // pay an async hop (and stay synchronous up to the provider call).
  check(): { wait: WaitRequest } | { woke: { text: string } } | null | Promise<{ wait: WaitRequest } | { woke: { text: string } } | null> {
    for (const due of dueWaits(this.db)) {
      const cursor = due.deadline ?? new Date().toISOString();
      const woken = recordWake(this.db, this.taskId, {
        wakeId: levelWakeId(this.taskId, due.source, cursor),
        waitId: due.waitId,
        edge: false,
        source: due.source,
        cursor,
        observation: `deadline reached: ${due.condition}`,
      });
      if (!woken.duplicate && woken.fired) {
        const consumed = consumeFiredWait(this.db, this.taskId, due.waitId);
        if (consumed !== null) return { woke: { text: consumed.observation } };
      }
    }
    for (const fired of listFiredWaits(this.db, this.taskId)) {
      const consumed = consumeFiredWait(this.db, this.taskId, fired.waitId);
      if (consumed !== null) return { woke: { text: consumed.observation } };
    }
    if (this.handles.size === 0) {
      // A stable wait resumed without any fire stays a wait: re-entering is
      // idempotent and costs zero model calls. Never proceed to the model
      // just because somebody restarted the loop.
      const [stable] = listActiveWaits(this.db, this.taskId);
      if (stable === undefined) return null;
      return {
        wait: {
          kind: stable.kind,
          condition: stable.condition,
          source: stable.source,
          observedCursor: stable.observedCursor,
          obligation: stable.obligation,
          ...(stable.deadline !== undefined ? { deadline: stable.deadline } : {}),
        },
      };
    }
    return this.probeHandles();
  }

  private async probeHandles(): Promise<{ wait: WaitRequest } | { woke: { text: string } } | null> {
    for (const handle of [...this.handles]) {
      const probed = await this.probe.pollProcess(handle);
      if ("lost" in probed) {
        this.handles.delete(handle);
        return { woke: { text: `supervised handle ${handle} is gone (${probed.reason}); treating the process as UNKNOWN until observed` } };
      }
      if (!probed.running) {
        this.handles.delete(handle);
        return { woke: { text: probed.observation } };
      }
    }
    const [first] = [...this.handles];
    if (first === undefined) return null;
    return {
      wait: {
        kind: "process",
        condition: `process ${first} still running`,
        source: `process:${first}`,
        observedCursor: "",
        obligation: this.obligation,
      },
    };
  }
}
