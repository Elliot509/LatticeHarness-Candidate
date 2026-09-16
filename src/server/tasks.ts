import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createContract, reviseContract, type TaskContract } from "../runtime/contract.js";
import {
  evaluateResumeGate,
  grantedFromContract,
  openRun,
  openSession,
  resumeTask as resumeTaskInDb,
  unknownHistory,
} from "../runtime/continuity.js";
import { HandleWaiter, edgeWakeId, levelWakeId, listActiveWaits, recordWake } from "../runtime/wait.js";
import { advanceCompositionEpoch, compositionForRoute } from "../runtime/composition.js";
import { taskBudgetSnapshot } from "../runtime/effects.js";
import { runTaskLoop, type LoopOptions, type LoopStop } from "../runtime/loop.js";
import { buildToolset } from "../tools/registry.js";
import { ProcessSupervisor } from "../tools/process.js";
import { VerifyLedger, summarizeExecResult } from "../runtime/verify.js";
import { OpenAiAdapter } from "../providers/openai.js";
import { findPreset, isKnownProviderId } from "../providers/presets.js";
import { resolveInScope } from "../platform/paths.js";
import type { ProviderAdapter } from "../providers/types.js";
import type { TaskSurface } from "../context/compiler.js";
import {
  PROTOCOL_VERSION,
  type BudgetView,
  type CommandResult,
  type MessageView,
  type SessionSummary,
  type SteeringView,
  type TaskSnapshot,
  type TaskState,
  type ToolActivityView,
  type UiCommand,
  type UiEvent,
  type VerificationView,
} from "./protocol.js";

export const PACKAGE_VERSION = "0.0.0";
const MAX_RING = 500;

export interface LiveRun {
  abort: AbortController;
  done: Promise<LoopStop>;
  pendingSteerings: Map<string, number>;
  pendingModel: { provider: string; model: string; baseUrl: string | null } | null;
  stopRequested: boolean;
}

export interface ServerTaskOptions {
  workspace: string;
  objective: string;
  acceptance: string[];
  provider: string;
  model: string;
  baseUrl: string | null;
}

interface StoredSteering {
  id: string;
  seq: number;
  text: string;
  mode: "guide" | "forbid";
  state: "received" | "accepted" | "applied";
  expectedRevision: number;
  appliedRevision: number | null;
  recordedAt: string;
}

export class TaskManager {
  private readonly live = new Map<string, LiveRun>();
  private readonly keys = new Map<string, string>();
  private readonly processedCommands = new Map<string, CommandResult>();
  private readonly rings = new Map<string, UiEvent[]>();
  private readonly seqs = new Map<string, number>();
  private readonly firstSeqs = new Map<string, number>();
  private readonly steerings = new Map<string, StoredSteering[]>();
  private readonly contracts = new Map<string, TaskContract>();
  private readonly subscribers = new Map<string, Set<(event: UiEvent) => void>>();
  private readonly db: DatabaseSync;
  readonly serverWorkspace: string;
  private readonly defaultGrants: { calls: number; tokens: number };
  private readonly productDir: string | null;

  constructor(
    db: DatabaseSync,
    serverWorkspace: string,
    defaultGrants: { calls: number; tokens: number } = { calls: 50, tokens: 200_000 },
    productDir: string | null = null,
  ) {
    this.db = db;
    this.serverWorkspace = serverWorkspace;
    this.defaultGrants = defaultGrants;
    this.productDir = productDir;
  }

  /** Device-global product config directory, or null when not configured. */
  get dataDir(): string | null {
    return this.productDir;
  }

  /** Server-side credential accessor for discovery/connection tests. Never serialized. */
  providerApiKey(provider: string): string {
    if (!isKnownProviderId(provider)) throw new Error(`unsupported provider ${provider}`);
    return this.apiKeyFor(provider);
  }

  /**
   * Resolve a workspace path request to a canonical absolute directory,
   * contained in the server root. Same checks as task creation, without
   * creating anything. Returned path is safe to display and to pass back
   * as a create-task workspace.
   */
  resolveWorkspacePath(requested: string): { path: string; displayName: string } {
    if (typeof requested !== "string" || requested.trim() === "") {
      throw new Error("workspace path must be non-empty");
    }
    const resolved = this.resolveWorkspace(requested);
    return { path: resolved, displayName: path.basename(resolved) || resolved };
  }

  /**
   * List immediate child directories of a workspace path for the mediated
   * picker. No recursion, no file contents, capped. Throws on violations.
   */
  browseWorkspace(requested: string): Array<{ name: string; path: string }> {
    const resolved = this.resolveWorkspace(requested === "" ? "." : requested);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      throw new Error("workspace directory is not readable");
    }
    const root = path.resolve(this.serverWorkspace);
    let canonicalRoot: string;
    try {
      canonicalRoot = fs.realpathSync.native(root);
    } catch {
      throw new Error("workspace directory is not readable");
    }
    const dirs: Array<{ name: string; path: string }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.resolve(resolved, entry.name);
      let canonicalChild: string;
      try {
        canonicalChild = fs.realpathSync.native(child);
      } catch {
        continue;
      }
      if (canonicalChild !== canonicalRoot && !canonicalChild.startsWith(`${canonicalRoot}${path.sep}`)) continue;
      dirs.push({ name: entry.name, path: child });
      if (dirs.length >= 200) break;
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    return dirs;
  }

  keyConfigured(provider: string): boolean {
    if (!isKnownProviderId(provider)) return false;
    // LATTICE_API_KEY remains a fallback for the openai preset only; every
    // other preset resolves credentials from explicit in-memory keys.
    const env = provider === "openai" ? process.env["LATTICE_API_KEY"] : undefined;
    return (env !== undefined && env.trim() !== "") || this.keys.has(provider);
  }

  setKey(provider: string, key: string): void {
    if (!isKnownProviderId(provider) || key.trim() === "") {
      throw new Error("only a known provider preset accepts an in-memory key");
    }
    this.keys.set(provider, key);
  }

  removeKey(provider: string): boolean {
    if (!isKnownProviderId(provider)) {
      throw new Error("only a known provider preset has a key slot");
    }
    return this.keys.delete(provider);
  }

  private apiKeyFor(provider: string): string {
    if (provider === "openai") {
      return this.keys.get("openai") ?? process.env["LATTICE_API_KEY"] ?? "";
    }
    return this.keys.get(provider) ?? "";
  }

  private nextSeq(taskId: string): number {
    const next = (this.seqs.get(taskId) ?? this.maxPersistedSeq(taskId)) + 1;
    this.seqs.set(taskId, next);
    return next;
  }

  private maxPersistedSeq(taskId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE task_id = ?")
      .get(taskId) as { m: number };
    return row.m;
  }

  private emit(taskId: string, event: UiEvent): UiEvent {
    const full: UiEvent = { ...event, seq: this.nextSeq(taskId) };
    if (!this.firstSeqs.has(taskId)) this.firstSeqs.set(taskId, full.seq);
    const ring = this.rings.get(taskId) ?? [];
    ring.push(full);
    while (ring.length > MAX_RING) ring.shift();
    this.rings.set(taskId, ring);
    for (const subscriber of this.subscribers.get(taskId) ?? []) {
      try {
        subscriber(full);
      } catch {
        // A broken subscriber must not disturb the loop; SSE cleans up lazily.
      }
    }
    return full;
  }

  subscribe(taskId: string, subscriber: (event: UiEvent) => void): void {
    const set = this.subscribers.get(taskId) ?? new Set();
    set.add(subscriber);
    this.subscribers.set(taskId, set);
  }

  unsubscribe(taskId: string, subscriber: (event: UiEvent) => void): void {
    this.subscribers.get(taskId)?.delete(subscriber);
  }

  toolDetail(taskId: string, attemptId: string): { attemptId: string; detail: string; truncated: boolean } {
    this.contractOf(taskId);
    const row = this.db
      .prepare("SELECT detail FROM receipts WHERE attempt_id = ?")
      .get(attemptId) as { detail: string } | undefined;
    if (row === undefined) throw new Error(`unknown tool result ${attemptId}`);
    const detail = JSON.parse(row.detail) as { summary?: unknown; detail?: unknown };
    const inner = typeof detail.detail === "string" ? (JSON.parse(detail.detail) as { output?: unknown; outputTruncated?: unknown }) : {};
    const text = typeof inner.output === "string" ? inner.output : JSON.stringify(detail);
    const truncated = inner.outputTruncated === true || text.length > 64 * 1024;
    return { attemptId, detail: truncated ? text.slice(0, 64 * 1024) : text, truncated };
  }

  missedEvents(taskId: string, afterSeq: number): { events: UiEvent[]; resync: boolean } {
    // Broadcast seqs continue past persisted history; the snapshot always
    // covers everything older. Resync is only needed when broadcast events
    // the client missed have already fallen out of the ring.
    const ring = this.rings.get(taskId) ?? [];
    if (ring.length === 0) return { events: [], resync: false };
    const oldest = ring[0];
    if (oldest === undefined || afterSeq >= oldest.seq) {
      return { events: ring.filter((event) => event.seq > afterSeq), resync: false };
    }
    const firstEver = this.firstSeqs.get(taskId) ?? oldest.seq;
    if (afterSeq < firstEver) return { events: [...ring], resync: false };
    return { events: [], resync: true };
  }

  private recordEvent(taskId: string, kind: string, payload: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)")
      .run(kind, taskId, JSON.stringify(payload), new Date().toISOString());
  }

  private contractOf(taskId: string): TaskContract {
    const cached = this.contracts.get(taskId);
    if (cached !== undefined) return cached;
    const row = this.db.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as
      | { document: string }
      | undefined;
    if (row === undefined) throw new Error(`unknown task ${taskId}`);
    const contract = JSON.parse(row.document) as TaskContract;
    this.contracts.set(taskId, contract);
    return contract;
  }

  private writeContract(contract: TaskContract): void {
    this.db
      .prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET revision = excluded.revision, document = excluded.document, updated_at = excluded.updated_at")
      .run(contract.taskId, contract.rootId, contract.revision, JSON.stringify(contract), new Date().toISOString());
    this.contracts.set(contract.taskId, contract);
  }

  listSessions(): SessionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT r.run_id, r.session_id, r.root_id, r.task_id, r.created_at, c.document
         FROM runs r LEFT JOIN contracts c ON c.task_id = r.task_id
         WHERE r.created_at = (SELECT MAX(created_at) FROM runs WHERE task_id = r.task_id)
         ORDER BY r.created_at DESC LIMIT 100`,
      )
      .all() as Array<{
      run_id: string;
      session_id: string;
      root_id: string;
      task_id: string;
      created_at: string;
      document: string | null;
    }>;
    return rows.map((row) => {
      let objective = "";
      let workspace = this.serverWorkspace;
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
        taskId: row.task_id,
        rootId: row.root_id,
        workspace,
        objective,
        state: this.readState(row.task_id).state,
        updatedAt: row.created_at,
      };
    });
  }

  private readState(taskId: string): { state: TaskState; reason: string } {
    const row = this.db
      .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task-state' ORDER BY seq DESC LIMIT 1")
      .get(taskId) as { payload: string } | undefined;
    if (row === undefined) return { state: "READY", reason: "created" };
    try {
      const parsed = JSON.parse(row.payload) as { state?: unknown; reason?: unknown };
      if (typeof parsed.state === "string") {
        return { state: parsed.state as TaskState, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
      }
    } catch {
      // Fall through to READY rather than crashing on a bad row.
    }
    return { state: "READY", reason: "created" };
  }

  private setState(taskId: string, state: TaskState, reason: string): void {
    this.recordEvent(taskId, "task-state", { state, reason });
    this.emit(taskId, { seq: 0, kind: "state", state, reason, contractRevision: this.contractOf(taskId).revision });
  }

  createTask(options: ServerTaskOptions): { taskId: string; rootId: string } {
    const resolved = this.resolveWorkspace(options.workspace);
    if (options.objective.trim() === "") throw new Error("objective must be non-empty");
    if (!isKnownProviderId(options.provider)) throw new Error("only a known provider preset is served over HTTP");
    const taskId = `task-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;
    const contract = createContract({
      taskId,
      rootId,
      objective: options.objective,
      scope: [resolved],
      acceptanceCriteria: ["task completed as verified"],
      obligations: ["preserve human work"],
      grants: [
        {
          subject: "agent",
          operations: ["search", "read", "edit", "exec", "process", "model.invoke"],
          targets: [resolved],
          expiresAt: null,
          limits: { maxCalls: this.defaultGrants.calls, maxTokens: this.defaultGrants.tokens },
        },
      ],
      prohibitions: ["publish"],
      realm: "local-trusted",
      allowedProvider: options.provider,
      allowedModel: options.model,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "ui create-task",
    });
    this.writeContract(contract);
    const runId = `run-${randomUUID()}`;
    this.db
      .prepare("INSERT INTO runs (run_id, session_id, root_id, task_id, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        runId,
        `session-${randomUUID()}`,
        rootId,
        taskId,
        JSON.stringify({ provider: options.provider, model: options.model, baseUrl: options.baseUrl, workspace: resolved, packageVersion: PACKAGE_VERSION }),
        new Date().toISOString(),
      );
    this.steerings.set(taskId, []);
    this.setState(taskId, "READY", "task created");
    return { taskId, rootId };
  }

  private resolveWorkspace(requested: string): string {
    // Containment is decided on canonical paths (symlink-free) so a link
    // inside the root cannot point outside of it; the returned path stays
    // lexical to preserve exact scope strings, snapshots and UI display.
    if (resolveInScope(this.serverWorkspace, requested === "" ? "." : requested) === null) {
      throw new Error("workspace must stay inside the server workspace");
    }
    const root = path.resolve(this.serverWorkspace);
    const resolved = path.resolve(root, requested === "" ? "." : requested);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error("workspace directory does not exist");
    }
    return resolved;
  }

  startTask(taskId: string, commandId: string, adapterOverride?: ProviderAdapter): CommandResult {
    const contract = this.contractOf(taskId);
    const current = this.readState(taskId);
    if (current.state !== "READY") {
      return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: current.state };
    }
    const manifest = this.readManifest(taskId);
    const adapter = adapterOverride ?? this.buildAdapter(manifest.provider, manifest.baseUrl);    const live: LiveRun = {
      abort: new AbortController(),
      done: Promise.resolve({ decision: "STOP", reason: "", iterations: 0, modelCalls: 0, toolDispatches: 0 }),
      pendingSteerings: new Map(),
      pendingModel: null,
      stopRequested: false,
    };
    this.live.set(taskId, live);
    const supervisor = new ProcessSupervisor(contract.scope[0] ?? this.serverWorkspace);
    const ledger = new VerifyLedger();
    const surface: TaskSurface = {
      objective: contract.objective,
      acceptanceCriteria: [...contract.acceptanceCriteria],
      grants: ["search, read, edit, exec, process under workspace"],
      prohibitions: [...contract.prohibitions],
      obligations: [...contract.obligations],
      unknowns: [],
      humanDecisions: [],
      versions: [],
      lastError: null,
    };
    const modelRef = { provider: adapter, model: manifest.model };
    const tools = buildToolset({ supervisor });
    // Composition epoch: opened/advanced exactly once per activation under
    // the CURRENT route. Same route re-entry (refresh, reconnect, restart of
    // a READY task) reuses the stored epoch — no inflation. A pendingModel
    // switch advances it at the safe point (see selectModel/onLoopEvent).
    // (The epoch value is durably stored; the local binding is informational
    // here — model attempts bind per-request in the loop via bindRequest.)
    advanceCompositionEpoch(
      this.db,
      taskId,
      compositionForRoute(manifest.provider, manifest.model, tools.map((tool) => tool.definition)),
    );
    // A start after resume continues under the original session with a fresh
    // run; the granted budget always comes from the persisted contract.
    const taskRun = this.openTaskRun(taskId);
    const granted = grantedFromContract(contract);
    const generation = this.readGeneration();
    const waiter = new HandleWaiter(
      this.db,
      taskId,
      {
        pollProcess: async (handle) => {
          const out = await supervisor.execute({ op: "poll", handle, timeoutMs: 0, generation });
          if (out.errorKind !== undefined) return { lost: true, reason: out.summary };
          if (out.status === "completed" && out.complete === true) {
            return { running: false as const, observation: `[process ${handle}] ${out.summary}` };
          }
          return { running: true as const };
        },
      },
      contract.obligations[0] ?? "complete the task",
    );
    const execEntry = tools.find((entry) => entry.name === "exec");
    if (execEntry !== undefined) {
      const innerRun = execEntry.run.bind(execEntry);
      execEntry.run = async (argsJson, context) => {
        const startedAt = Date.now();
        const out = await innerRun(argsJson, context);
        const summary = summarizeExecResult(
          describeExecCommand(argsJson),
          context.workspaceRoot,
          out.result,
          Date.now() - startedAt,
        );
        ledger.record(summary);
        this.recordEvent(taskId, "verification", {
          command: summary.command,
          cwd: summary.cwd,
          exitCode: summary.exitCode,
          passed: summary.passed,
          failed: summary.failed,
          skipped: summary.skipped,
          countsKnown: summary.countsKnown,
        });
        return out;
      };
    }
    const loopOptions: LoopOptions = {
      db: this.db,
      provider: adapter,
      model: manifest.model,
      modelRef,
      contract,
      sessionId: taskRun.sessionId,
      runId: taskRun.runId,
      taskSurface: surface,
      tools,
      toolContext: { workspaceRoot: contract.scope[0] ?? this.serverWorkspace, realm: "local-trusted", timeoutMs: 5 * 60 * 1000 },
      ownerGeneration: generation,
      grantedCalls: granted.calls,
      grantedTokens: granted.tokens,
      maxIterations: 25,
      signal: live.abort.signal,
      acceptanceVerifiers: [() => ledger.check()],
      waiter,
      onEvent: (event) => {
        if (event.kind === "tool-end") waiter.noteToolEnd(event.tool, event.status, event.handle);
        this.onLoopEvent(taskId, live, event);
      },
      onModelText: (text) => {
        this.recordEvent(taskId, "chat", { author: "agent", text });
      },
    };
    this.setState(taskId, "RUNNING", "loop started");
    live.done = runTaskLoop(loopOptions).then(
      (stop) => {
        this.onLoopStop(taskId, live, stop.decision, stop.reason, stop.wait);
        return stop;
      },
      (error: unknown) => {
        const stop = { decision: "ESCALATE" as const, reason: error instanceof Error ? error.message : "loop crashed", iterations: 0, modelCalls: 0, toolDispatches: 0 };
        this.onLoopStop(taskId, live, stop.decision, stop.reason);
        return stop;
      },
    );
    void live.done.catch(() => undefined);
    return { accepted: true, commandId, taskId, revision: contract.revision, state: "RUNNING" };
  }

  private readManifest(taskId: string): { provider: string; model: string; baseUrl: string | null; workspace: string } {
    const row = this.db.prepare("SELECT manifest FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as
      | { manifest: string }
      | undefined;
    if (row === undefined) throw new Error(`no run for task ${taskId}`);
    const manifest = JSON.parse(row.manifest) as { provider?: unknown; model?: unknown; baseUrl?: unknown; workspace?: unknown };
    const manifestProvider = manifest.provider;
    if (typeof manifestProvider !== "string" || !isKnownProviderId(manifestProvider) || typeof manifest.model !== "string") {
      throw new Error(`unsupported run composition for task ${taskId}`);
    }
    return {
      provider: manifestProvider,
      model: manifest.model,
      baseUrl: typeof manifest.baseUrl === "string" ? manifest.baseUrl : null,
      workspace: typeof manifest.workspace === "string" ? manifest.workspace : "",
    };
  }

  private buildAdapter(provider: string, baseUrl: string | null): ProviderAdapter {
    // S5: every known preset speaks OpenAI Chat Completions, so one adapter
    // serves them all. The preset id selects configuration, never protocol.
    // A null base resolves to the preset default (custom has none: it must
    // always carry an explicit endpoint).
    if (!isKnownProviderId(provider)) throw new Error(`unsupported provider ${provider}`);
    const effectiveBase = baseUrl ?? findPreset(provider)?.defaultBaseUrl ?? null;
    const apiKey = this.apiKeyFor(provider);
    if (effectiveBase === null) {
      throw new Error(`${provider} needs an explicit base URL`);
    }
    if (apiKey.trim() === "" && findPreset(provider)?.keyRequired === true && baseUrl === null) {
      throw new Error(`${provider} needs an in-memory key or an explicit base URL`);
    }
    return new OpenAiAdapter({ apiKey, baseUrl: effectiveBase });
  }

  private readGeneration(): number {
    const row = this.db.prepare("SELECT generation FROM ownership WHERE id = 1").get() as
      | { generation: number }
      | undefined;
    return row?.generation ?? 1;
  }

  private openTaskRun(taskId: string): { sessionId: string; runId: string } {
    const contract = this.contractOf(taskId);
    const { sessionId } = openSession(this.db, contract.rootId);
    // The new run inherits the task's composition (provider/model/binding);
    // only resume metadata is added. A stub manifest here would break
    // readManifest, which always reads the latest run row.
    const previous = this.db.prepare("SELECT manifest FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").get(taskId) as
      | { manifest: string }
      | undefined;
    let inherited: Record<string, unknown> = {};
    if (previous !== undefined) {
      try {
        inherited = JSON.parse(previous.manifest) as Record<string, unknown>;
      } catch {
        inherited = {};
      }
    }
    const runId = openRun(this.db, {
      sessionId,
      rootId: contract.rootId,
      taskId,
      manifest: { ...inherited, resumedStart: true, packageVersion: PACKAGE_VERSION },
    });
    return { sessionId, runId };
  }

  private onLoopEvent(
    taskId: string,
    live: LiveRun,
    event: { kind: string; attemptId?: string; tool?: string; status?: string; toolCalls?: number },
  ): void {
    if (event.kind === "model-request") {
      this.applyPending(taskId, live);
    }
    if (event.kind === "model-response") {
      return;
    }
    if (event.kind === "tool-start" && event.tool !== undefined && event.attemptId !== undefined) {
      this.emit(taskId, {
        seq: 0,
        kind: "tool",
        tool: {
          id: event.attemptId,
          seq: 0,
          tool: event.tool,
          target: null,
          status: "running",
          summary: `${event.tool} started`,
          detail: null,
          version: null,
          complete: false,
          truncated: false,
          durationMs: null,
          recordedAt: new Date().toISOString(),
        },
      });
    }
    if (event.kind === "tool-end" && event.tool !== undefined && event.attemptId !== undefined) {
      this.emit(taskId, {
        seq: 0,
        kind: "tool",
        tool: {
          id: event.attemptId,
          seq: 0,
          tool: event.tool,
          target: null,
          status: toToolStatus("RESOLVED", event.status === "confirmed" ? "confirmed" : event.status === "unknown" ? "unknown" : "failed"),
          summary: `${event.tool} ${event.status ?? "ended"}`,
          detail: null,
          version: null,
          complete: event.status === "confirmed" || event.status === "failed" ? true : event.status === "unknown" ? false : null,
          truncated: false,
          durationMs: null,
          recordedAt: new Date().toISOString(),
        },
      });
    }
  }

  private applyPending(taskId: string, live: LiveRun): void {
    for (const [steeringId, revision] of live.pendingSteerings) {
      const list = this.steerings.get(taskId) ?? [];
      const record = list.find((entry) => entry.id === steeringId);
      if (record !== undefined && record.state === "accepted") {
        record.state = "applied";
        record.appliedRevision = revision;
        this.recordEvent(taskId, "steering-applied", { id: steeringId, revision });
        this.emit(taskId, { seq: 0, kind: "steering", steering: toSteeringView(record), contractRevision: revision });
      }
    }
    live.pendingSteerings.clear();
    // Safe-point route switch: the pending model becomes the CURRENT route
    // exactly once, at a model-request boundary (never mid-dispatch), and
    // advances the composition epoch. Late responses to older epochs stay
    // evidence for their own attempts (see composition.ts) and never restore
    // the previous route.
    if (live.pendingModel !== null) {
      const pending = live.pendingModel;
      live.pendingModel = null;
      try {
        const manifest = this.readManifest(taskId);
        const tools = buildToolset({});
        const next = advanceCompositionEpoch(
          this.db,
          taskId,
          compositionForRoute(pending.provider, pending.model, tools.map((tool) => tool.definition)),
        );
        this.db
          .prepare("UPDATE runs SET manifest = ? WHERE task_id = ?")
          .run(
            JSON.stringify({ provider: pending.provider, model: pending.model, baseUrl: pending.baseUrl, workspace: manifest.workspace, packageVersion: PACKAGE_VERSION, compositionEpoch: next.epoch, compositionDigest: next.digest }),
            taskId,
          );
        this.recordEvent(taskId, "composition", { provider: pending.provider, model: pending.model, baseUrl: pending.baseUrl, applied: true, epoch: next.epoch, digest: next.digest });
      } catch {
        // Fail closed on manifest/epoch errors: the switch does not apply,
        // the loop continues on the current route with evidence preserved.
        this.recordEvent(taskId, "composition", { provider: pending.provider, model: pending.model, applied: false, reason: "epoch advance failed" });
      }
    }
  }

  private onLoopStop(taskId: string, live: LiveRun, decision: string, reason: string, wait?: { kind: string }): void {
    // A stable WAIT is not a completion: the loop already persisted the
    // WAITING/NEEDS_INPUT state, so only non-waiting outcomes transition here.
    if (wait !== undefined) {
      this.live.delete(taskId);
      const waiting: TaskState = wait.kind === "input" ? "NEEDS_INPUT" : "WAITING";
      this.emit(taskId, { seq: 0, kind: "state", state: waiting, reason, contractRevision: this.contractOf(taskId).revision });
      return;
    }
    const state: TaskState = live.stopRequested
      ? "CANCELLED"
      : decision === "STOP"
        ? "COMPLETED"
        : decision === "ASK"
          ? "NEEDS_INPUT"
          : decision === "ESCALATE"
            ? "BLOCKED"
            : "CANCELLED";
    const finalReason = live.stopRequested && state === "CANCELLED" ? `stop requested; ${reason}` : reason;
    this.live.delete(taskId);
    this.setState(taskId, state, finalReason);
  }

  steer(taskId: string, commandId: string, expectedRevision: number, text: string, mode: "guide" | "forbid"): CommandResult {
    const contract = this.contractOf(taskId);
    const current = this.readState(taskId);
    if (current.state !== "RUNNING" && current.state !== "READY" && current.state !== "NEEDS_INPUT") {
      return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: current.state };
    }
    if (expectedRevision !== contract.revision) {
      return { accepted: false, commandId, reason: "stale", revision: contract.revision, state: current.state };
    }
    if (text.trim() === "") {
      return { accepted: false, commandId, reason: "invalid", revision: contract.revision, state: current.state };
    }
    const revised =
      mode === "forbid"
        ? reviseContract(contract, { prohibitions: [...contract.prohibitions, text.trim()], origin: "ui steering" })
        : reviseContract(contract, { obligations: [...contract.obligations, `user steering: ${text.trim()}`], origin: "ui steering" });
    Object.assign(contract, revised);
    this.writeContract(contract);
    const record: StoredSteering = {
      id: `steer-${randomUUID().slice(0, 8)}`,
      seq: 0,
      text: text.trim(),
      mode,
      state: "accepted",
      expectedRevision,
      appliedRevision: null,
      recordedAt: new Date().toISOString(),
    };
    const list = this.steerings.get(taskId) ?? [];
    list.push(record);
    this.steerings.set(taskId, list);
    this.recordEvent(taskId, "steering", { id: record.id, text: record.text, mode, expectedRevision, revision: contract.revision });
    this.recordEvent(taskId, "chat", { author: "user", text: record.text, id: record.id });
    this.emit(taskId, {
      seq: 0,
      kind: "message",
      message: { id: record.id, seq: 0, author: "user", text: record.text, recordedAt: record.recordedAt },
    });
    const live = this.live.get(taskId);
    if (live !== undefined && current.state === "RUNNING") {
      live.pendingSteerings.set(record.id, contract.revision);
    } else {
      record.state = "applied";
      record.appliedRevision = contract.revision;
    }
    this.emit(taskId, { seq: 0, kind: "steering", steering: toSteeringView(record), contractRevision: contract.revision });
    return { accepted: true, commandId, taskId, revision: contract.revision, state: current.state };
  }

  stop(taskId: string, commandId: string): CommandResult {
    const contract = this.contractOf(taskId);
    const current = this.readState(taskId);
    const live = this.live.get(taskId);
    if (live === undefined || current.state !== "RUNNING") {
      return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: current.state };
    }
    live.stopRequested = true;
    live.abort.abort();
    return { accepted: true, commandId, taskId, revision: contract.revision, state: current.state };
  }

  // Manual resume over the wire: evaluates the ResumeGate and, only when it
  // allows, opens a new run under the same session. Never starts the loop;
  // the client sends start-task explicitly afterwards.
  resumeTask(taskId: string, commandId: string): CommandResult {
    const contract = this.contractOf(taskId);
    if (this.live.get(taskId) !== undefined) {
      return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: this.readState(taskId).state };
    }
    // The resume run inherits the task composition so later reads of the
    // latest manifest keep working; only resume metadata is added.
    let composition: Record<string, unknown> = {};
    try {
      const manifest = this.readManifest(taskId);
      composition = { provider: manifest.provider, model: manifest.model, baseUrl: manifest.baseUrl };
    } catch {
      // No usable composition yet: the gate below fails closed on its own.
    }
    const report = resumeTaskInDb(this.db, { taskId, generation: this.readGeneration(), packageVersion: PACKAGE_VERSION, manifestExtra: composition });
    if (!report.canResume) {
      return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: this.readState(taskId).state };
    }
    this.emit(taskId, { seq: 0, kind: "state", state: this.readState(taskId).state, reason: "resumed; ready to start", contractRevision: contract.revision });
    return { accepted: true, commandId, taskId, revision: contract.revision, state: this.readState(taskId).state };
  }

  // Delivers one wake through the WakeGate. Edge wakes (input, approvals)
  // get a fresh id and never coalesce; level wakes derive a stable id.
  wakeTask(
    taskId: string,
    commandId: string,
    input: { source: string; cursor: string; observation: string; waitId?: string; edge: boolean },
  ): CommandResult {
    const contract = this.contractOf(taskId);
    const state = this.readState(taskId).state;
    const wakeId = input.edge ? edgeWakeId() : levelWakeId(taskId, input.source, input.cursor);
    try {
      const result = recordWake(this.db, taskId, {
        wakeId,
        ...(input.waitId !== undefined ? { waitId: input.waitId } : {}),
        edge: input.edge,
        source: input.source,
        cursor: input.cursor,
        observation: input.observation,
      });
      if (result.duplicate) {
        return { accepted: false, commandId, reason: "duplicate", revision: contract.revision, state };
      }
      return { accepted: true, commandId, taskId, revision: contract.revision, state };
    } catch {
      return { accepted: false, commandId, reason: "invalid", revision: contract.revision, state };
    }
  }

  selectModel(taskId: string, commandId: string, provider: string, model: string, baseUrl: string | null): CommandResult {
    const contract = this.contractOf(taskId);
    const current = this.readState(taskId);
    if (!isKnownProviderId(provider) || model.trim() === "") {
      return { accepted: false, commandId, reason: "invalid", revision: contract.revision, state: current.state };
    }
    if (provider === "custom" && baseUrl === null) {
      return { accepted: false, commandId, reason: "invalid", revision: contract.revision, state: current.state };
    }
    if (baseUrl === null && findPreset(provider)?.keyRequired === true && !this.keyConfigured(provider)) {
      return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: current.state };
    }
    const live = this.live.get(taskId);
    if (live !== undefined && current.state === "RUNNING") {
      live.pendingModel = { provider, model, baseUrl };
    } else {
      this.db
        .prepare("UPDATE runs SET manifest = ? WHERE task_id = ?")
        .run(JSON.stringify({ provider, model, baseUrl, workspace: contract.scope[0] ?? this.serverWorkspace, packageVersion: PACKAGE_VERSION }), taskId);
    }
    this.recordEvent(taskId, "composition", { provider, model, baseUrl, applied: live === undefined });
    return { accepted: true, commandId, taskId, revision: contract.revision, state: current.state };
  }

  handleCommand(command: UiCommand): CommandResult {
    const seen = this.processedCommands.get(command.commandId);
    if (seen !== undefined) return seen;
    if (this.processedCommands.size > 1000) {
      const oldest = this.processedCommands.keys().next();
      if (!oldest.done) this.processedCommands.delete(oldest.value);
    }
    let result: CommandResult;
    try {
      result = this.dispatch(command);
    } catch {
      const taskId = command.taskId;
      const revision = taskId !== undefined ? this.safeRevision(taskId) : 0;
      const state = taskId !== undefined ? this.safeState(taskId) : "READY";
      result = { accepted: false, commandId: command.commandId, reason: "invalid", revision, state };
    }
    this.processedCommands.set(command.commandId, result);
    return result;
  }

  private safeRevision(taskId: string): number {
    try {
      return this.contractOf(taskId).revision;
    } catch {
      return 0;
    }
  }

  private safeState(taskId: string): TaskState {
    try {
      return this.readState(taskId).state;
    } catch {
      return "READY";
    }
  }

  private dispatch(command: UiCommand): CommandResult {
    const payload = command.payload ?? {};
    switch (command.kind) {
      case "create-task": {
        const objective = payload["objective"];
        const provider = payload["provider"];
        const model = payload["model"];
        if (typeof objective !== "string" || typeof provider !== "string" || typeof model !== "string") {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        const workspace = typeof payload["workspace"] === "string" ? payload["workspace"] : this.serverWorkspace;
        const baseUrl = typeof payload["baseUrl"] === "string" ? payload["baseUrl"] : null;
        if (provider === "custom" && baseUrl === null) {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        const { taskId } = this.createTask({ workspace, objective, acceptance: [], provider, model, baseUrl });
        const contract = this.contractOf(taskId);
        return { accepted: true, commandId: command.commandId, taskId, revision: contract.revision, state: "READY" };
      }
      case "start-task": {
        if (command.taskId === undefined) {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        return this.startTask(command.taskId, command.commandId);
      }
      case "steer": {
        if (command.taskId === undefined || command.expectedRevision === undefined) {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        const text = payload["text"];
        const mode = payload["mode"];
        if (typeof text !== "string" || (mode !== "guide" && mode !== "forbid")) {
          const revision = this.safeRevision(command.taskId);
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision, state: this.safeState(command.taskId) };
        }
        return this.steer(command.taskId, command.commandId, command.expectedRevision, text, mode);
      }
      case "stop": {
        if (command.taskId === undefined) {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        return this.stop(command.taskId, command.commandId);
      }
      case "resume-task": {
        if (command.taskId === undefined) {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        return this.resumeTask(command.taskId, command.commandId);
      }
      case "wake": {
        if (command.taskId === undefined) {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        const source = payload["source"];
        const cursor = payload["cursor"];
        const observation = payload["observation"];
        if (typeof source !== "string" || typeof cursor !== "string" || typeof observation !== "string") {
          const revision = this.safeRevision(command.taskId);
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision, state: this.safeState(command.taskId) };
        }
        const waitId = payload["waitId"];
        const edge = payload["edge"];
        return this.wakeTask(command.taskId, command.commandId, {
          source,
          cursor,
          observation,
          ...(typeof waitId === "string" ? { waitId } : {}),
          edge: edge !== false,
        });
      }
      case "select-model": {
        if (command.taskId === undefined) {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        const provider = payload["provider"];
        const model = payload["model"];
        const baseUrl = payload["baseUrl"];
        if (typeof provider !== "string" || typeof model !== "string" || (baseUrl !== undefined && baseUrl !== null && typeof baseUrl !== "string")) {
          const revision = this.safeRevision(command.taskId);
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision, state: this.safeState(command.taskId) };
        }
        return this.selectModel(command.taskId, command.commandId, provider, model, baseUrl ?? null);
      }
      case "set-key": {
        const provider = payload["provider"];
        const key = payload["key"];
        if (typeof provider !== "string" || !isKnownProviderId(provider) || typeof key !== "string" || key.trim() === "") {
          return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        }
        this.setKey(provider, key);
        return { accepted: true, commandId: command.commandId, taskId: command.taskId ?? "", revision: 0, state: "READY" };
      }
    }
  }

  snapshot(taskId: string): TaskSnapshot {
    const contract = this.contractOf(taskId);
    const state = this.readState(taskId);
    const manifest = this.readManifest(taskId);
    const messages = this.readMessages(taskId);
    const tools = this.readTools(taskId);
    const verifications = this.readVerifications(taskId);
    const steering = (this.steerings.get(taskId) ?? []).map(toSteeringView);
    const budget = this.readBudget(taskId);
    const unknowns = this.countUnknowns(taskId);
    const live = this.live.get(taskId);
    const gate = this.resumePreview(taskId);
    return {
      protocol: PROTOCOL_VERSION,
      taskId,
      rootId: contract.rootId,
      workspace: contract.scope[0] ?? this.serverWorkspace,
      objective: contract.objective,
      acceptanceCriteria: [...contract.acceptanceCriteria],
      state: state.state,
      stateReason: state.reason,
      contractRevision: contract.revision,
      provider: live?.pendingModel?.provider ?? manifest.provider,
      model: live?.pendingModel?.model ?? manifest.model,
      baseUrl: manifest.baseUrl,
      keyConfigured: this.keyConfigured(manifest.provider),
      unknowns,
      unknownHistory: unknownHistory(this.db, taskId).map((entry) => ({
        attemptId: entry.attemptId,
        operation: entry.operation,
        target: entry.target,
        reason: entry.reason,
        recordedAt: entry.recordedAt,
      })),
      waits: listActiveWaits(this.db, taskId).map((wait) => ({
        waitId: wait.waitId,
        kind: wait.kind,
        condition: wait.condition,
        obligation: wait.obligation,
        state: wait.state,
      })),
      resumable: gate.canResume,
      resumeBlockers: gate.blockers.map((blocker) => blocker.code),
      budget,
      contextUsage: { known: false },
      messages,
      tools,
      verifications,
      steering,
      cut: this.seqs.get(taskId) ?? this.maxPersistedSeq(taskId),
    };
  }

  private readMessages(taskId: string): MessageView[] {
    const rows = this.db
      .prepare("SELECT seq, payload, recorded_at FROM events WHERE task_id = ? AND kind = 'chat' ORDER BY seq ASC LIMIT 500")
      .all(taskId) as Array<{ seq: number; payload: string; recorded_at: string }>;
    const messages: MessageView[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as { author?: unknown; text?: unknown; id?: unknown };
        if ((parsed.author === "user" || parsed.author === "agent" || parsed.author === "system") && typeof parsed.text === "string") {
          messages.push({
            id: typeof parsed.id === "string" ? parsed.id : `ev-${row.seq}`,
            seq: row.seq,
            author: parsed.author,
            text: parsed.text,
            recordedAt: row.recorded_at,
          });
        }
      } catch {
        // Skip unreadable rows; the ledger stays queryable.
      }
    }
    return messages;
  }

  private readTools(taskId: string): ToolActivityView[] {
    const rows = this.db
      .prepare(
        `SELECT a.attempt_id, a.created_at, i.operation, i.target, a.state, r.outcome, r.detail, r.recorded_at
         FROM attempts a
         JOIN intents i ON i.intent_id = a.intent_id
         LEFT JOIN receipts r ON r.attempt_id = a.attempt_id
         WHERE i.task_id = ? AND i.operation != 'model.invoke'
         ORDER BY a.created_at ASC LIMIT 500`,
      )
      .all(taskId) as Array<{
      attempt_id: string;
      created_at: string;
      operation: string;
      target: string | null;
      state: string;
      outcome: string | null;
      detail: string | null;
      recorded_at: string | null;
    }>;
    return rows.map((row, index) => {
      let summary = row.state;
      let detail: string | null = null;
      let version: string | null = null;
      if (row.detail !== null) {
        try {
          const parsed = JSON.parse(row.detail) as { summary?: unknown; detail?: unknown };
          if (typeof parsed.summary === "string") summary = parsed.summary;
          if (typeof parsed.detail === "string") detail = parsed.detail.slice(0, 4000);
          const versionMatch = /"afterVersion"\s*:\s*"([^"]+)"/.exec(row.detail);
          if (versionMatch?.[1] !== undefined) version = versionMatch[1];
        } catch {
          summary = row.state;
        }
      }
      const durationMs = durationBetween(row.created_at, row.recorded_at);
      return {
        id: row.attempt_id,
        seq: index,
        tool: row.operation,
        target: row.target,
        status: toToolStatus(row.state, row.outcome),
        summary,
        detail,
        version,
        complete: row.state === "RESOLVED" || row.state === "RECONCILED" ? true : row.state === "UNKNOWN" ? false : null,
        truncated: detail !== null && detail.length >= 4000,
        durationMs,
        recordedAt: row.recorded_at ?? row.created_at,
      };
    });
  }

  private readVerifications(taskId: string): VerificationView[] {
    const rows = this.db
      .prepare("SELECT seq, payload, recorded_at FROM events WHERE task_id = ? AND kind = 'verification' ORDER BY seq ASC LIMIT 100")
      .all(taskId) as Array<{ seq: number; payload: string; recorded_at: string }>;
    const verifications: VerificationView[] = [];
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload) as Record<string, unknown>;
        verifications.push({
          id: `verify-${row.seq}`,
          seq: row.seq,
          command: typeof parsed["command"] === "string" ? parsed["command"] : "unknown",
          cwd: typeof parsed["cwd"] === "string" ? parsed["cwd"] : "",
          exitCode: typeof parsed["exitCode"] === "number" ? parsed["exitCode"] : null,
          passed: typeof parsed["passed"] === "number" ? parsed["passed"] : null,
          failed: typeof parsed["failed"] === "number" ? parsed["failed"] : null,
          skipped: typeof parsed["skipped"] === "number" ? parsed["skipped"] : null,
          countsKnown: parsed["countsKnown"] === true,
          recordedAt: row.recorded_at,
        });
      } catch {
        // Skip unreadable rows.
      }
    }
    return verifications;
  }

  private readBudget(taskId: string): BudgetView {
    const granted = grantedFromContract(this.contractOf(taskId));
    const snapshot = taskBudgetSnapshot(this.db, taskId, granted);
    return {
      grantedCalls: snapshot.granted.calls,
      grantedTokens: snapshot.granted.tokens,
      reservedCalls: snapshot.reserved.calls,
      reservedTokens: snapshot.reserved.tokens,
      settledCalls: snapshot.settled.calls,
      settledTokens: snapshot.settled.tokens,
    };
  }

  private countUnknowns(taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND state = 'UNKNOWN'")
      .get(taskId) as { n: number };
    return row.n;
  }

  // Read-only gate preview for the snapshot: never invalidates in-flight
  // admissions of a live run, only reports. Classification happens on real
  // resume (gate or resume-task command), never on a hot read path.
  private resumePreview(taskId: string): { canResume: boolean; blockers: Array<{ code: string }> } {
    try {
      const report = evaluateResumeGate(
        this.db,
        { taskId, generation: this.readGeneration(), packageVersion: PACKAGE_VERSION },
        { classifyPending: !this.live.has(taskId) },
      );
      return { canResume: report.canResume, blockers: report.blockers };
    } catch {
      return { canResume: false, blockers: [{ code: "gate-error" }] };
    }
  }
}

function durationBetween(startedAt: string, recordedAt: string | null): number | null {
  if (recordedAt === null) return null;
  const duration = Date.parse(recordedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function toToolStatus(state: string, outcome: string | null): ToolActivityView["status"] {
  if (state === "UNKNOWN") return "unknown";
  if (outcome === "unknown") return "unknown";
  if (outcome === "failed") return "failed";
  if (outcome === "confirmed") return "completed";
  if (state === "CLAIMED" || state === "ADMITTED") return "running";
  if (state === "RECONCILED" || state === "RESOLVED") return "completed";
  return "failed";
}

function describeExecCommand(argsJson: string): string {
  try {
    const parsed = JSON.parse(argsJson) as { executable?: unknown; argv?: unknown; command?: unknown };
    if (typeof parsed.executable === "string") {
      const argv = Array.isArray(parsed.argv) ? parsed.argv.filter((a): a is string => typeof a === "string") : [];
      return `${parsed.executable} ${argv.join(" ")}`.trim();
    }
    if (typeof parsed.command === "string") return `shell: ${parsed.command.slice(0, 200)}`;
  } catch {
    // Fall through to the opaque label below.
  }
  return "exec";
}

function toSteeringView(record: StoredSteering): SteeringView {
  return {
    id: record.id,
    seq: record.seq,
    text: record.text,
    mode: record.mode,
    state: record.state,
    expectedRevision: record.expectedRevision,
    appliedRevision: record.appliedRevision,
    recordedAt: record.recordedAt,
  };
}
