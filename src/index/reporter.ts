import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLatticeDb } from "../storage/db.js";
import { listSessions } from "../runtime/continuity.js";
import { buildSessionExport, serializeExport, writeExportFile } from "../telemetry/export.js";
import { adaptExportSnapshot, toClientPayload } from "./adapter.js";
import { findAgentsView, probeLatticeSupport, queryDailyUsage } from "./agentsview.js";
import { clientCollect, clientStatus, clientSupportsAgentFilter, findPython, redactSecrets } from "./client.js";

// Separate reporting supervisor. Disabled by default, opt-in only. Reads an
// immutable export snapshot per session, never holds a runtime transaction
// across network calls, never invokes the model, and never touches task
// authority. A crashing reporter, a dead network, or a missing upstream
// binary leaves every Lattice task untouched: the tick just records pending.

export interface IndexReporterConfig {
  enabled: boolean;
  agentId: string;
  days: number;
  agentsviewPath?: string | undefined;
  clientScript?: string | undefined;
  pythonPath?: string | undefined;
  credentialFile?: string | undefined;
}

export interface ReporterPaths {
  dataDir: string;
  indexDir: string;
  exportsDir: string;
  avDataHome: string;
  configFile: string;
  stateFile: string;
}

export function reporterPaths(dataDir: string): ReporterPaths {
  const indexDir = path.join(dataDir, "index");
  return {
    dataDir,
    indexDir,
    exportsDir: path.join(indexDir, "exports"),
    avDataHome: path.join(indexDir, "avdata"),
    configFile: path.join(indexDir, "config.json"),
    stateFile: path.join(indexDir, "state.json"),
  };
}

export function loadReporterConfig(paths: ReporterPaths): IndexReporterConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(paths.configFile, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record: Record<string, unknown> = parsed as Record<string, unknown>;
  const agentId: unknown = record["agentId"];
  if (typeof agentId !== "string" || agentId === "") return null;
  const days: unknown = record["days"];
  const agentsviewPath: unknown = record["agentsviewPath"];
  const clientScript: unknown = record["clientScript"];
  const pythonPath: unknown = record["pythonPath"];
  const credentialFile: unknown = record["credentialFile"];
  return {
    enabled: record["enabled"] === true,
    agentId,
    days: typeof days === "number" && Number.isInteger(days) && days > 0 ? days : 28,
    ...(typeof agentsviewPath === "string" ? { agentsviewPath } : {}),
    ...(typeof clientScript === "string" ? { clientScript } : {}),
    ...(typeof pythonPath === "string" ? { pythonPath } : {}),
    ...(typeof credentialFile === "string" ? { credentialFile } : {}),
  };
}

export function saveReporterConfig(paths: ReporterPaths, config: IndexReporterConfig): void {
  fs.mkdirSync(paths.indexDir, { recursive: true });
  fs.writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`);
}

export type ReporterStatus =
  | "disabled"
  | "unavailable"
  | "pending"
  | "reported"
  | "already-running";

export interface TickResult {
  status: ReporterStatus;
  detail: string;
  reportedDays?: number | undefined;
  reportedTokens?: number | undefined;
}

interface ReporterState {
  lastSuccessAt: string | null;
  lastSuccessDays: number;
  lastSuccessTokens: number;
  consecutiveFailures: number;
  nextAllowedAt: string | null;
  pendingReason: string | null;
}

function defaultState(): ReporterState {
  return {
    lastSuccessAt: null,
    lastSuccessDays: 0,
    lastSuccessTokens: 0,
    consecutiveFailures: 0,
    nextAllowedAt: null,
    pendingReason: null,
  };
}

function loadState(paths: ReporterPaths): ReporterState {
  try {
    const parsed = JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as Partial<ReporterState>;
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function saveState(paths: ReporterPaths, state: ReporterState): void {
  fs.mkdirSync(paths.indexDir, { recursive: true });
  fs.writeFileSync(paths.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

// Bounded backoff between attempts after failures: 1m, 2m, 4m ... capped at
// 1h. Success resets the chain.
export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(60_000 * 2 ** Math.min(consecutiveFailures - 1, 5), 3_600_000);
}

// Hermes presence gate: a Hermes usage store with rows would merge foreign
// usage into the report through the official client's second collector.
// Refuse instead of contaminating. Mirrors the client's own store check
// (table + content, not mere file existence).
export function hasHermesStore(): { present: boolean; where: string } {
  const candidates: string[] = [];
  const fromEnv = process.env["HERMES_HOME"];
  if (fromEnv !== undefined && fromEnv !== "") candidates.push(fromEnv);
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  if (home !== "") candidates.push(path.join(home, ".hermes"), path.join(home, ".hermes-life"));
  for (const dir of candidates) {
    const db = path.join(dir, "state.db");
    if (hermesStoreHasRows(db)) return { present: true, where: db };
  }
  return { present: false, where: "" };
}

function hermesStoreHasRows(dbPath: string): boolean {
  // node:sqlite URI filenames (file:...?mode=ro) need a new-enough runtime;
  // the floor is Node 22.13, so open the plain path read-only by default
  // instead: no write ever happens here, and a missing/locked file fails
  // closed below.
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_model_usage'").get();
    if (table === undefined) return false;
    const count = db.prepare("SELECT COUNT(*) AS n FROM session_model_usage").get() as { n: number };
    return count.n > 0;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // Best effort.
    }
  }
}

// Reads a credential file as data (never `source`): returns the
// PLOW_AGENT_TOKEN value when the file carries one, without ever logging it.
export function readCredentialToken(credentialFile: string): string | null {
  let text: string;
  try {
    text = fs.readFileSync(credentialFile, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("PLOW_AGENT_TOKEN=")) continue;
    const value = trimmed.slice("PLOW_AGENT_TOKEN=".length).trim().replace(/^["']|["']$/g, "");
    return value === "" ? null : value;
  }
  return null;
}

export interface TickOptions {
  // Test/CI seams. Production passes the loopback override only implicitly
  // (never), real runs post to the official Index.
  apiOverride?: string | undefined;
  now?: Date | undefined;
  // Runs the collection through the official client but stops before any
  // publish: proves the whole chain without sending anything.
  dryRun?: boolean | undefined;
  // Working directory for spawned helpers. Production leaves it unset
  // (inherit); tests point it at a stub directory for hermetic runs.
  spawnCwd?: string | undefined;
}

// One supervised reporting pass. Phase 1 touches only local state (ledger,
// export files, dedicated index); phase 2 talks to the network through the
// official client. A failure anywhere records pending and backs off; it
// never blocks, duplicates, or invents usage.
export async function reporterTick(dataDir: string, options: TickOptions = {}): Promise<TickResult> {
  const paths = reporterPaths(dataDir);
  const config = loadReporterConfig(paths);
  if (config === null) return { status: "unavailable", detail: "index not configured; run lattice index setup" };
  if (!config.enabled) return { status: "disabled", detail: "index reporting disabled" };
  const state = loadState(paths);
  const now = options.now ?? new Date();
  if (state.nextAllowedAt !== null && Date.parse(state.nextAllowedAt) > now.getTime()) {
    return { status: "pending", detail: `backing off until ${state.nextAllowedAt}` };
  }

  // Hermes on this machine would merge foreign usage into the report through
  // the official client's second collector. Refuse instead of contaminating.
  // Checked before the lock: no lock is needed to refuse.
  const hermes = hasHermesStore();
  if (hermes.present) {
    return {
      status: "unavailable",
      detail: `Hermes store present at ${hermes.where}; Lattice reporting refuses to mix foreign usage (see lattice index setup)`,
    };
  }

  // Single-flight across processes: a lock file with owner and timestamp;
  // stale locks (owner gone or older than 10 minutes) are taken over, never
  // waited on forever. The lock wraps discovery, probe, export, verify and
  // publish so two concurrent ticks never interleave them.
  const lockFile = path.join(paths.indexDir, "tick.lock");
  if (!acquireTickLock(lockFile)) {
    return { status: "already-running", detail: "another reporter tick holds the lock" };
  }
  try {
    return await tickLocked(paths, dataDir, config, state, now, options);
  } finally {
    releaseTickLock(lockFile);
  }
}

function acquireTickLock(lockFile: string): boolean {
  try {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const stamp = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    try {
      fs.writeFileSync(lockFile, stamp, { flag: "wx" });
      return true;
    } catch {
      // Lock present: take over only when stale.
    }
    let existing: { pid?: unknown; startedAt?: unknown };
    try {
      existing = JSON.parse(fs.readFileSync(lockFile, "utf8")) as { pid?: unknown; startedAt?: unknown };
    } catch {
      return false;
    }
    const pid = typeof existing.pid === "number" ? existing.pid : null;
    const startedAt = typeof existing.startedAt === "string" ? Date.parse(existing.startedAt) : NaN;
    const stale = pid === null || !Number.isFinite(startedAt) || Date.now() - startedAt > 10 * 60 * 1000 || !processAlive(pid);
    if (!stale) return false;
    try {
      fs.writeFileSync(lockFile, stamp);
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseTickLock(lockFile: string): void {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    // Best effort; a stale lock is taken over by the next tick.
  }
}

async function tickLocked(
  paths: ReporterPaths,
  dataDir: string,
  config: IndexReporterConfig,
  state: ReporterState,
  now: Date,
  options: TickOptions,
): Promise<TickResult> {
  const fail = (detail: string): TickResult => {
    state.consecutiveFailures += 1;
    state.nextAllowedAt = new Date(now.getTime() + backoffMs(state.consecutiveFailures)).toISOString();
    state.pendingReason = redactSecrets(detail).slice(0, 500);
    saveState(paths, state);
    return { status: "pending", detail: redactSecrets(detail).slice(0, 500) };
  };
  const agentsview = findAgentsView(config.agentsviewPath);
  if (agentsview === null) {
    return fail("agentsview executable not found; run lattice index setup");
  }
  const probe = await probeLatticeSupport(agentsview, 120000, options.spawnCwd);
  if (!probe.supported) {
    return fail(`agentsview without Lattice support: ${probe.reason}`);
  }
  const python = findPython(config.pythonPath);
  if (python === null || config.clientScript === undefined || !fs.existsSync(config.clientScript)) {
    return fail("official client script or python3 not found; run lattice index setup");
  }
  if (!clientSupportsAgentFilter(config.clientScript)) {
    return fail("official client without the Lattice agent filter; refusing to report unfiltered totals");
  }
  let expected: ReturnType<typeof toClientPayload>;
  try {
    expected = exportAllSessions(dataDir, paths);
  } catch (error) {
    return fail(`export failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  let indexed: Awaited<ReturnType<typeof queryDailyUsage>>;
  try {
    indexed = await queryDailyUsage({
      binary: agentsview,
      env: { dataDir: paths.avDataHome, exportsDir: paths.exportsDir },
      agent: "lattice",
      ...(options.spawnCwd !== undefined ? { cwd: options.spawnCwd } : {}),
    });
  } catch (error) {
    return fail(`agentsview query failed: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  const mismatch = comparePayloads(expected, indexed);
  if (mismatch !== null) {
    return fail(`agentsview totals do not match the ledger export: ${mismatch}`);
  }

  // Registration state is informational here, but an unregistered install
  // cannot report: stay pending instead of failing loudly every tick.
  // os.homedir() (never the data dir) keeps the official identity at home.
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? os.homedir();
  const registration = await clientStatus({ python, script: config.clientScript }, home);
  if (registration.state !== "registered") {
    return fail(`official client is ${registration.state}; register before reporting (see lattice index setup)`);
  }

  // Phase 2: network, through the official client only.
  const credentialToken =
    config.credentialFile !== undefined ? (readCredentialToken(config.credentialFile) ?? undefined) : undefined;
  const run = await clientCollect(
    { python, script: config.clientScript },
    {
      agent: config.agentId,
      days: config.days,
      dryRun: options.dryRun ?? false,
      home,
      agentsviewDataDir: paths.avDataHome,
      exportsDir: paths.exportsDir,
      ...(options.apiOverride !== undefined ? { apiOverride: options.apiOverride } : {}),
      ...(credentialToken !== undefined ? { credentialToken } : {}),
    },
  );
  if (run.timedOut || run.exitCode !== 0) {
    return fail(`official client failed (exit ${run.exitCode ?? "?"}, timeout=${run.timedOut}): ${run.stderr.slice(0, 300)}`);
  }
  const tokens = expected.reduce(
    (sum, day) => sum + day.models.reduce((inner, model) => inner + model.input + model.output + model.cache_read + model.cache_write, 0),
    0,
  );
  state.lastSuccessAt = now.toISOString();
  state.lastSuccessDays = expected.length;
  state.lastSuccessTokens = tokens;
  state.consecutiveFailures = 0;
  state.nextAllowedAt = null;
  state.pendingReason = null;
  saveState(paths, state);
  return { status: "reported", detail: `reported ${expected.length} day(s), ${tokens} tokens`, reportedDays: expected.length, reportedTokens: tokens };
}

// The pending queue is the single latest snapshot by construction: every
// tick re-exports current ledger state, so nothing accumulates and no
// separate bounded queue can overflow.

// Exports every session carrying model usage into the dedicated directory
// and returns the adapter payload the index must reproduce exactly. A
// session whose window is incomplete (unknown, provisional, unattributed)
// fails the whole tick instead of publishing a partial total across the
// remaining sessions: omissions must stay explicit, never silent.
function exportAllSessions(dataDir: string, paths: ReporterPaths): ReturnType<typeof toClientPayload> {
  const db = openLatticeDb(dataDir);
  try {
    fs.mkdirSync(paths.exportsDir, { recursive: true });
    const sessions = listSessions(db.raw);
    const days = new Map<string, Map<string, { model: string; input: number; output: number; cache_read: number; cache_write: number }>>();
    const incomplete: string[] = [];
    for (const session of sessions) {
      let text: string;
      try {
        const exported = buildSessionExport(db.raw, session.sessionId, "0.0.0");
        if (exported.complete.recordCount === 0) continue;
        text = serializeExport(exported).join("\n");
      } catch {
        continue;
      }
      let adapted;
      try {
        adapted = adaptExportSnapshot(text);
      } catch (error) {
        incomplete.push(`${session.sessionId}: ${error instanceof Error ? error.message : "incomplete"}`.slice(0, 200));
        continue;
      }
      writeExportFile(path.join(paths.exportsDir, `${session.sessionId}.jsonl`), text.split("\n"));
      for (const day of toClientPayload(adapted)) {
        let models = days.get(day.date);
        if (models === undefined) {
          models = new Map();
          days.set(day.date, models);
        }
        for (const model of day.models) {
          const existing = models.get(model.model);
          if (existing === undefined) models.set(model.model, { ...model });
          else {
            existing.input += model.input;
            existing.output += model.output;
            existing.cache_read += model.cache_read;
            existing.cache_write += model.cache_write;
          }
        }
      }
    }
    if (incomplete.length > 0) {
      throw new Error(`incomplete session windows, refusing a partial total: ${incomplete.join(" | ").slice(0, 400)}`);
    }
    return [...days.entries()]
      .map(([date, models]) => ({ date, models: [...models.values()].sort((a, b) => (a.model < b.model ? -1 : 1)) }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  } finally {
    db.close();
  }
}

function comparePayloads(
  expected: ReturnType<typeof toClientPayload>,
  indexed: Awaited<ReturnType<typeof queryDailyUsage>>,
): string | null {
  const actual = new Map<string, Map<string, { input: number; output: number; cache_read: number; cache_write: number }>>();
  for (const day of indexed) {
    const models = new Map<string, { input: number; output: number; cache_read: number; cache_write: number }>();
    actual.set(day.date, models);
    for (const model of day.modelBreakdowns) {
      models.set(model.modelName, {
        input: model.inputTokens,
        output: model.outputTokens,
        cache_read: model.cacheReadTokens,
        cache_write: model.cacheCreationTokens,
      });
    }
  }
  for (const day of expected) {
    const models = actual.get(day.date);
    if (models === undefined) return `date ${day.date} missing from the index`;
    for (const model of day.models) {
      const row = models.get(model.model);
      if (row === undefined) return `model ${model.model} on ${day.date} missing from the index`;
      if (row.input !== model.input || row.output !== model.output || row.cache_read !== model.cache_read || row.cache_write !== model.cache_write) {
        return `counters differ for ${model.model} on ${day.date}`;
      }
      models.delete(model.model);
    }
    if (models.size > 0) return `index holds extra models on ${day.date}`;
  }
  for (const [date, models] of actual) {
    if (models.size > 0) return `index holds an extra date ${date}`;
  }
  return null;
}
