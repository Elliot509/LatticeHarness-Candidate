import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { throwIfFault } from "../runtime/faults.js";
import type { AttemptStatus, AttemptUsage } from "./usage.js";

// Local export v1 (TELEMETRY §5): a JSONL snapshot of one session. First
// line `session`, then one `attempt_usage` line per physical model attempt
// (latest revision each), last line `export_complete`. The export is a
// downstream projection: it never touches the loop, holds no locks, and a
// missing exporter never affects execution. This module stops at the local
// file; anything beyond (AgentsView, ranking) is S4.

export const EXPORT_SCHEMA_VERSION = 1;

export interface UsageCoverage {
  attempts: number;
  observed: number;
  estimated: number;
  unknown: number;
  knownInputTotal: number;
  knownOutputTotal: number;
}

export interface ExportSessionHeader {
  schemaVersion: 1;
  recordType: "session";
  sessionId: string;
  rootId: string;
  createdAt: string;
  exportedAt: string;
  ledgerCut: number;
  exportRevision: number;
  producer: "Lattice";
  packageVersion: string;
  usageCoverage: UsageCoverage;
  timezone: "UTC";
}

export interface ExportAttemptLine {
  recordType: "attempt_usage";
  canonicalDay: string | null;
  usage: AttemptUsage;
}

export interface ExportComplete {
  recordType: "export_complete";
  sessionId: string;
  recordCount: number;
  ledgerCut: number;
}

export class IncompleteExportError extends Error {
  constructor(detail: string) {
    super(`not a complete export snapshot: ${detail}`);
    this.name = "IncompleteExportError";
  }
}

export class SecretLeakError extends Error {  constructor(detail: string) {
    super(`export refused: possible secret in usage data (${detail})`);
    this.name = "SecretLeakError";
  }
}

interface AttemptRow {
  attempt_id: string;
  request_id: string | null;  generation: number;
  created_at: string;
  attempt_state: string;
  intent_id: string;
  operation: string;
  task_id: string;
  receipt_outcome: string | null;
  usage_revision: number | null;
  usage_document: string | null;
}

function ledgerCut(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS cut FROM events").get() as { cut: number };
  return row.cut;
}

function sessionRoot(db: DatabaseSync, sessionId: string): string | null {
  const row = db
    .prepare("SELECT root_id FROM runs WHERE session_id = ? ORDER BY created_at ASC LIMIT 1")
    .get(sessionId) as { root_id: string } | undefined;
  return row?.root_id ?? null;
}

function sessionCreatedAt(db: DatabaseSync, sessionId: string): string {
  const row = db
    .prepare("SELECT created_at FROM runs WHERE session_id = ? ORDER BY created_at ASC LIMIT 1")
    .get(sessionId) as { created_at: string } | undefined;
  return row?.created_at ?? new Date(0).toISOString();
}

function exportRevision(db: DatabaseSync, sessionId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'export' AND payload LIKE ?")
    .get(`%${sessionId}%`) as { n: number };
  return row.n + 1;
}

function statusOf(row: AttemptRow): AttemptStatus {
  if (row.attempt_state === "UNKNOWN") return "unknown";
  if (row.attempt_state === "ADMITTED" || row.attempt_state === "CLAIMED") return "pending";
  if (row.attempt_state === "INVALIDATED") return "cancelled";
  if (row.receipt_outcome === "failed") return "failed";
  if (row.receipt_outcome === "unknown") return "unknown";
  if (row.receipt_outcome === "confirmed") return "completed";
  return "pending";
}

function unknownQuantity(source: string) {
  return { value: null, quality: "unknown" as const, source };
}

// Canonical attribution day: UTC day of finishedAt for terminal attempts;
// attempts without an end stay pending with a null day, never dumped into
// the export day.
export function canonicalDay(usage: AttemptUsage): string | null {
  if (usage.finishedAt === null) return null;
  const time = Date.parse(usage.finishedAt);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

function usageFromRow(row: AttemptRow, sessionId: string, rootId: string): AttemptUsage {
  if (row.usage_document !== null) {
    const stored = parseStoredUsage(row.usage_document);
    if (stored !== null && stored.attemptId === row.attempt_id) {
      return { ...stored, usageRevision: row.usage_revision ?? stored.usageRevision };
    }
  }
  const status = statusOf(row);
  const stamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    sessionId,
    runId: "",
    taskId: row.task_id,
    rootId,
    requestId: row.request_id ?? "",
    attemptId: row.attempt_id,
    parentAttemptId: null,
    intentId: row.intent_id,
    executorGeneration: row.generation,
    provider: "",
    modelRequested: "",
    modelResolved: null,
    adapterRevision: null,
    usageRevision: 0,
    usageFinal: false,
    purpose: "primary",
    status,
    admittedAt: row.created_at,
    dispatchedAt: row.created_at,
    firstTokenAt: null,
    finishedAt: status === "pending" ? null : stamp,
    recordedAt: stamp,
    clockQuality: "wall",
    durationMs: null,
    providerRequestId: null,
    error: null,
    inputTotal: unknownQuantity("lattice-export"),
    inputNew: unknownQuantity("lattice-export"),
    cacheRead: unknownQuantity("lattice-export"),
    cacheWrite: unknownQuantity("lattice-export"),
    outputTotal: unknownQuantity("lattice-export"),
    reasoningSubset: null,
  };
}

function parseStoredUsage(document: string): AttemptUsage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  if (typeof (parsed as Record<string, unknown>)["attemptId"] !== "string") return null;
  return parsed as AttemptUsage;
}

export interface SessionExport {
  header: ExportSessionHeader;
  lines: ExportAttemptLine[];
  complete: ExportComplete;
}

export function buildSessionExport(
  db: DatabaseSync,
  sessionId: string,
  packageVersion: string,
  now: Date = new Date(),
): SessionExport {
  const rootId = sessionRoot(db, sessionId);
  if (rootId === null) throw new Error(`unknown session ${sessionId}`);
  const cut = ledgerCut(db);
  const rows = db
    .prepare(
      `SELECT a.attempt_id, a.request_id, a.generation, a.created_at, a.state AS attempt_state,
              i.intent_id, i.operation, i.task_id,
              (SELECT r.outcome FROM receipts r WHERE r.attempt_id = a.attempt_id) AS receipt_outcome,
              u.revision AS usage_revision, u.document AS usage_document
       FROM attempts a
       JOIN intents i ON i.intent_id = a.intent_id
       JOIN contracts c ON c.task_id = i.task_id
       LEFT JOIN attempt_usage u ON u.attempt_id = a.attempt_id
       WHERE c.root_id = ? AND i.operation = 'model.invoke'
       ORDER BY a.created_at ASC`,
    )
    .all(rootId) as Array<{
    attempt_id: string;
    request_id: string | null;
    generation: number;
    created_at: string;
    attempt_state: string;
    intent_id: string;
    operation: string;
    task_id: string;
    receipt_outcome: string | null;
    usage_revision: number | null;
    usage_document: string | null;
  }>;
  const lines = rows.map((row) => {
    const usage = usageFromRow(row, sessionId, rootId);
    return { recordType: "attempt_usage" as const, canonicalDay: canonicalDay(usage), usage };
  });
  const coverage = summarizeCoverage(lines.map((line) => line.usage));
  const header: ExportSessionHeader = {
    schemaVersion: 1,
    recordType: "session",
    sessionId,
    rootId,
    createdAt: sessionCreatedAt(db, sessionId),
    exportedAt: now.toISOString(),
    ledgerCut: cut,
    exportRevision: exportRevision(db, sessionId),
    producer: "Lattice",
    packageVersion,
    usageCoverage: coverage,
    timezone: "UTC",
  };
  const complete: ExportComplete = {
    recordType: "export_complete",
    sessionId,
    recordCount: lines.length,
    ledgerCut: cut,
  };
  assertNoSecrets(header, lines);
  return { header, lines, complete };
}

function summarizeCoverage(usages: AttemptUsage[]): UsageCoverage {
  let observed = 0;
  let estimated = 0;
  let unknown = 0;
  let knownInputTotal = 0;
  let knownOutputTotal = 0;
  for (const usage of usages) {
    const qualities = [usage.inputTotal.quality, usage.outputTotal.quality];
    if (qualities.every((quality) => quality === "observed")) observed += 1;
    else if (qualities.some((quality) => quality === "unknown")) unknown += 1;
    else estimated += 1;
    if (usage.inputTotal.value !== null) knownInputTotal += usage.inputTotal.value;
    if (usage.outputTotal.value !== null) knownOutputTotal += usage.outputTotal.value;
  }
  return { attempts: usages.length, observed, estimated, unknown, knownInputTotal, knownOutputTotal };
}

// Fail-closed privacy scan: allowlisted structure only, and no secret-shaped
// values anywhere. Field names that suggest credentials and high-confidence
// secret patterns refuse the whole export rather than shipping a leak.
const SECRET_FIELD = /^(api[_-]?key|apikey|secret|client[_-]?secret|password|passwd|cookie|session[_-]?cookie|authorization|auth[_-]?token|private[_-]?key)$/i;
// The bare-alnum alternative requires a non-alphanumeric boundary: task and
// attempt ids (`task-<hex>`, `attempt-<hex>`) legitimately contain "sk-"
// followed by hex, and must never trip the scan.
const SECRET_VALUE = /(aik_[A-Za-z0-9_-]{8,}|sk-(?:test|live|proj|ant|sv)-[A-Za-z0-9_-]{4,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20,}|Bearer\s+\S+|PLOW_AGENT_TOKEN|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bpas]-[A-Za-z0-9-]+)/;

export function assertNoSecrets(header: ExportSessionHeader, lines: ExportAttemptLine[]): void {
  const visit = (value: unknown, trail: string): void => {
    if (typeof value === "string") {
      if (SECRET_VALUE.test(value)) throw new SecretLeakError(`value at ${trail} matches a secret pattern`);
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, entry] of value.entries()) {
        visit(entry, `${trail}[${index}]`);
      }
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) {
        if (SECRET_FIELD.test(key)) throw new SecretLeakError(`field ${trail}.${key} suggests a credential`);
        visit(entry, `${trail}.${key}`);
      }
    }
  };
  visit(header, "session");
  for (const [index, line] of lines.entries()) {
    visit(line, `attempt[${index}]`);
  }
}

export function serializeExport(exported: SessionExport): string[] {
  return [
    JSON.stringify(exported.header),
    ...exported.lines.map((line) => JSON.stringify(line)),
    JSON.stringify(exported.complete),
  ];
}

// Atomic file replacement: everything lands in a temp sibling first and the
// destination is swapped only after the terminator is written. A mid-write
// failure leaves the previous valid export untouched. Cross-platform: on
// Windows an existing destination is unlinked before the rename.
export function writeExportFile(destPath: string, lines: string[]): void {
  const dir = path.dirname(destPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.export-${process.pid}-${randomUUID().slice(0, 8)}.tmp`);
  try {
    const half = Math.ceil(lines.length / 2);
    for (const [index, line] of lines.entries()) {
      fs.appendFileSync(tmpPath, `${line}\n`, "utf8");
      if (index + 1 === half) throwIfFault("export-mid-write");
    }
    safeReplace(tmpPath, destPath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // The temp path is best effort; the original error stays actionable.
    }
    throw error;
  }
}

function safeReplace(tmpPath: string, destPath: string): void {
  try {
    fs.renameSync(tmpPath, destPath);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "EEXIST" || code === "EPERM") {
      fs.rmSync(destPath, { force: true });
      fs.renameSync(tmpPath, destPath);
      return;
    }
    throw error;
  }
}

export interface ParsedExport {
  header: ExportSessionHeader;
  attempts: AttemptUsage[];
  complete: ExportComplete;
}

// Strict parser for the round-trip test and any future consumer: a file
// without a matching terminator is never treated as a complete snapshot,
// and partial files cannot be indexed as totals.
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseExportFile(text: string): ParsedExport {
  const rawLines = text.split("\n").filter((line) => line.trim() !== "");
  if (rawLines.length === 0) throw new IncompleteExportError("empty file");
  let headerRaw: unknown;
  try {
    headerRaw = JSON.parse(rawLines[0] ?? "");
  } catch {
    throw new IncompleteExportError("first line is not a session header");
  }
  if (!isRecord(headerRaw) || headerRaw["recordType"] !== "session" || headerRaw["schemaVersion"] !== 1) {
    throw new IncompleteExportError("first line is not a session header");
  }
  if (headerRaw["producer"] !== "Lattice") {
    throw new IncompleteExportError(
      `snapshot producer is ${JSON.stringify(headerRaw["producer"])}, not Lattice; refusing foreign data`,
    );
  }
  const header = headerRaw as unknown as ExportSessionHeader;
  const last = rawLines[rawLines.length - 1] ?? "";
  let completeRaw: unknown;
  try {
    completeRaw = JSON.parse(last);
  } catch {
    throw new IncompleteExportError("missing export_complete terminator");
  }
  if (!isRecord(completeRaw) || completeRaw["recordType"] !== "export_complete") {
    throw new IncompleteExportError("missing export_complete terminator");
  }
  const complete = completeRaw as unknown as ExportComplete;
  const attempts: AttemptUsage[] = [];
  for (const line of rawLines.slice(1, -1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new IncompleteExportError("unparseable attempt_usage line");
    }
    if (!isRecord(parsed) || parsed["recordType"] !== "attempt_usage") {
      throw new IncompleteExportError("non attempt_usage line inside snapshot");
    }
    const usage = parsed["usage"];
    if (!isRecord(usage) || typeof usage["attemptId"] !== "string") {
      throw new IncompleteExportError("attempt_usage line without a valid usage document");
    }
    attempts.push(usage as unknown as AttemptUsage);
  }
  if (complete.recordCount !== attempts.length) {
    throw new IncompleteExportError(`terminator counts ${complete.recordCount} records but ${attempts.length} found`);
  }
  if (complete.sessionId !== header.sessionId || complete.ledgerCut !== header.ledgerCut) {
    throw new IncompleteExportError("terminator does not match the session header");
  }
  return { header, attempts, complete };
}
