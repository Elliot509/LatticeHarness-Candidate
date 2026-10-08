import { throwIfFault } from "../runtime/faults.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { normalizeEndpoint, requireCredentialTransport } from "../providers/endpoint.js";
import { createContract, reviseContract, type TaskContract } from "../runtime/contract.js";
import {
  evaluateResumeGate,
  grantedFromContract,
  openRun,
  openSession,
  recordTaskEvent,
  resumeTask as resumeTaskInDb,
  unknownHistory,
} from "../runtime/continuity.js";
import { HandleWaiter, edgeWakeId, levelWakeId, listActiveWaits, recordWake, notePendingRevision, takePendingRevisions } from "../runtime/wait.js";
import { advanceCompositionEpoch, compositionForRoute } from "../runtime/composition.js";
import { taskBudgetSnapshot } from "../runtime/effects.js";
import type { BudgetGrant } from "../runtime/budget.js";
import { runTaskLoop, type LoopOptions, type LoopStop } from "../runtime/loop.js";
import { buildToolset } from "../tools/registry.js";
import { ProcessSupervisor } from "../tools/process.js";
import { summarizeExecResult } from "../runtime/verify.js";
import { TaskAcceptance, defaultAcceptance } from "../runtime/acceptance.js";
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
  supervisor: ProcessSupervisor;
  waitAbort: AbortController | null;
}

export interface ServerTaskOptions {
  workspace: string;
  objective: string;
  acceptance: string[];
  provider: string;
  model: string;
  baseUrl: string | null;
  budget?: BudgetGrant;
  expiresAt?: string | null;
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
  private currentWorkspace: string;
  private readonly defaultGrants: { calls: number | null; tokens: number | null };
  private readonly productDir: string | null;
  private draining = false;
  private closing: Promise<void> | null = null;
  private readonly nativeProjectSelection: boolean;

  constructor(
    db: DatabaseSync,
    serverWorkspace: string,
    defaultGrants: { calls: number | null; tokens: number | null } = { calls: null, tokens: null },
    productDir: string | null = null,
    nativeProjectSelection = false,
  ) {
    this.db = db;
    this.currentWorkspace = serverWorkspace;
    this.defaultGrants = defaultGrants;
    this.productDir = productDir;
    this.nativeProjectSelection = nativeProjectSelection;
  }

  /** Device-global product config directory, or null when not configured. */
  get dataDir(): string | null {
    return this.productDir;
  }

  get serverWorkspace(): string { return this.currentWorkspace; }

  // Only the private desktop parent channel may establish a new root.
  selectNativeWorkspace(selected: string): string {
    if (!this.nativeProjectSelection || this.draining || this.live.size !== 0) throw new Error("project selection is unavailable while a task is active");
    const root = fs.realpathSync.native(selected);
    if (!fs.statSync(root).isDirectory()) throw new Error("choose an existing project directory");
    if (root === path.parse(root).root || root === fs.realpathSync.native(os.homedir())) throw new Error("choose a project folder inside your home or drive");
    this.currentWorkspace = root;
    return root;
  }

  get activeTaskCount(): number { return this.live.size; }

  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    this.draining = true;
    const runs = [...this.live.values()];
    for (const live of runs) {
      live.stopRequested = true;
      live.abort.abort();
    }
    this.closing = Promise.all(runs.map((live) => live.done)).then(() => undefined).finally(() => { this.keys.clear(); });
    return this.closing;
  }

  /** Server-side credential accessor for discovery/connection tests. Never serialized. */
  providerApiKey(provider: string, baseUrl: string | null = null): string {
    if (!isKnownProviderId(provider)) throw new Error(`unsupported provider ${provider}`);
    return this.apiKeyFor(provider, baseUrl);
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

  private credentialSlot(provider: string, baseUrl: string | null): string {
    if (!isKnownProviderId(provider)) throw new Error("unsupported provider");
    const endpoint = baseUrl?.trim() || findPreset(provider)?.defaultBaseUrl;
    if (!endpoint) throw new Error("custom credentials need an explicit endpoint");
    return `${provider}:${normalizeEndpoint(endpoint)}`;
  }

  keyConfigured(provider: string, baseUrl: string | null = null): boolean {
    try { return this.apiKeyFor(provider, baseUrl).trim() !== ""; } catch { return false; }
  }

  setKey(provider: string, key: string, baseUrl: string | null = null): void {
    if (key.trim() === "") throw new Error("an in-memory key must be non-empty");
    const slot = this.credentialSlot(provider, baseUrl);
    requireCredentialTransport(slot.slice(provider.length + 1), key);
    this.keys.set(slot, key);
  }

  removeKey(provider: string): boolean {
    if (!isKnownProviderId(provider)) throw new Error("unsupported provider");
    let removed = false;
    for (const slot of this.keys.keys()) if (slot.startsWith(`${provider}:`)) removed = this.keys.delete(slot) || removed;
    return removed;
  }

  private apiKeyFor(provider: string, baseUrl: string | null = null): string {
    const slot = this.credentialSlot(provider, baseUrl);
    const key = this.keys.get(slot);
    if (key !== undefined) return key;
    const defaultSlot = `openai:${normalizeEndpoint("https://api.openai.com/v1")}`;
    return slot === defaultSlot ? process.env["LATTICE_API_KEY"] ?? "" : "";
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
      .prepare("SELECT r.detail FROM receipts r JOIN attempts a ON a.attempt_id = r.attempt_id JOIN intents i ON i.intent_id = a.intent_id WHERE r.attempt_id = ? AND i.task_id = ?")
      .get(attemptId, taskId) as { detail: string } | undefined;
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

  private recordEvent(taskId: string, kind: string, payload: Record<string, unknown>): number {
    const inserted = this.db
      .prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)")
      .run(kind, taskId, JSON.stringify(payload), new Date().toISOString());
    // Project committed observations through the same readers as snapshots.
    // Live clients must see verification and chat without reloading the UI.
    if (kind === "chat") {
      const message = this.readMessages(taskId).at(-1);
      if (message !== undefined) this.emit(taskId, { seq: 0, kind: "message", message });
    } else if (kind === "verification") {
      const verification = this.readVerifications(taskId).at(-1);
      if (verification !== undefined) this.emit(taskId, { seq: 0, kind: "verification", verification });
    }
    return Number(inserted.lastInsertRowid);
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
    this.emit(taskId, { seq: 0, kind: "budget", budget: this.readBudget(taskId) });
    this.emit(taskId, { seq: 0, kind: "state", state, reason, contractRevision: this.contractOf(taskId).revision });
  }

  createTask(options: ServerTaskOptions): { taskId: string; rootId: string } {
    if (this.draining) throw new Error("runtime is shutting down");
    const resolved = this.resolveWorkspace(options.workspace);
    if (options.baseUrl !== null) normalizeEndpoint(options.baseUrl);
    if (options.objective.trim() === "") throw new Error("objective must be non-empty");
    if (!isKnownProviderId(options.provider)) throw new Error("only a known provider preset is served over HTTP");
    const taskId = `task-${randomUUID()}`;
    const rootId = `root-${randomUUID()}`;
    const contract = createContract({
      taskId,
      rootId,
      objective: options.objective,
      scope: [resolved],
      acceptanceCriteria: options.acceptance.length > 0 ? options.acceptance : defaultAcceptance(options.objective),
      obligations: ["preserve human work"],
      grants: [
        {
          subject: "agent",
          operations: ["search", "read", "edit", "exec", "process", "model.invoke"],
          targets: [resolved],
          expiresAt: null,
          limits: { maxCalls: (options.budget ?? this.defaultGrants).calls, maxTokens: (options.budget ?? this.defaultGrants).tokens },
        },
      ],
      prohibitions: ["publish"],
      realm: "local-trusted",
      allowedProvider: options.provider,
      allowedModel: options.model,
      expiresAt: options.expiresAt ?? null,
      retentionPolicy: "retain until explicit deletion",
      origin: "ui create-task",
    });
    this.writeContract(contract);
    const runId = `run-${randomUUID()}`;
    this.db
      .prepare("INSERT INTO runs (run_id, session_id, root_id, task_id, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        runId,
        openSession(this.db, rootId).sessionId,
        rootId,
        taskId,
        JSON.stringify({ provider: options.provider, model: options.model, baseUrl: options.baseUrl, workspace: resolved, packageVersion: PACKAGE_VERSION }),
        new Date().toISOString(),
      );
    this.steerings.set(taskId, []);
    this.recordEvent(taskId, "chat", { author: "user", text: options.objective, id: `objective-${taskId}` });
    this.setState(taskId, "READY", "task created");
    return { taskId, rootId };
  }

  private resolveWorkspace(requested: string): string {
    if (this.serverWorkspace === "") throw new Error("choose a project before creating a task");
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
    if (this.draining || this.live.size !== 0 || current.state !== "READY") {
      return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: current.state };
    }
    const manifest = this.readManifest(taskId);
    const adapter = adapterOverride ?? this.buildAdapter(manifest.provider, manifest.baseUrl);
    const supervisor = new ProcessSupervisor(contract.scope[0] ?? this.serverWorkspace);
    const live: LiveRun = {
      abort: new AbortController(),
      done: Promise.resolve({ decision: "STOP", reason: "", iterations: 0, modelCalls: 0, toolDispatches: 0 }),
      pendingSteerings: new Map(),
      pendingModel: null,
      stopRequested: false,
      supervisor,
      waitAbort: null,
    };
    this.live.set(taskId, live);
    const acceptance = new TaskAcceptance(contract.scope[0] ?? this.serverWorkspace, contract.acceptanceCriteria);
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
    const modelRef = { provider: adapter, model: manifest.model, providerId: manifest.provider, endpoint: normalizeEndpoint(manifest.baseUrl ?? findPreset(manifest.provider)?.defaultBaseUrl ?? "") };
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
        pollProcess: (handle) => {
          const out = supervisor.observe(handle, generation);
          if (out.errorKind !== undefined) return Promise.resolve({ lost: true as const, reason: out.summary });
          if (out.status === "completed" && out.complete === true) {
            return Promise.resolve({ running: false as const, observation: `[process ${handle}] ${out.summary}\n${out.detail?.slice(0, 64 * 1024) ?? ""}${(out.detail?.length ?? 0) > 64 * 1024 ? "\n[durable observation output truncated; explicit process poll retains supervisor output]" : ""}` });
          }
          return Promise.resolve({ running: true as const });
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
    for (const tool of tools) {
      const run = tool.run.bind(tool);
      tool.run = async (argsJson, context) => {
        await acceptance.prepare(tool.name, context.signal);
        const outcome = await run(argsJson, context);
        await acceptance.observe(tool.name, argsJson, outcome.result);
        return outcome;
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
      signal: live.abort.signal,
      beforeRequest: () => {
        this.applyPending(taskId, live, modelRef);
        surface.objective = contract.objective;
        surface.acceptanceCriteria = [...contract.acceptanceCriteria];
        surface.prohibitions = [...contract.prohibitions];
        surface.obligations = [...contract.obligations];
        surface.humanDecisions = this.storedSteerings(taskId).map((record) => record.text);
        surface.unknowns = unknownHistory(this.db, taskId).map((entry) => `${entry.attemptId}: ${entry.reason}`);
      },
      onRequestBound: (binding) => {
        // Publish the active route only with its binding and revision ACK.
        // Preparing a route that admission later denies remains pending.
        this.db.prepare("UPDATE runs SET manifest = ? WHERE run_id = ? AND task_id = ?").run(
          JSON.stringify({ ...manifest, provider: binding.provider, model: binding.model, baseUrl: binding.endpoint, packageVersion: PACKAGE_VERSION }), taskRun.runId, taskId);
        this.acknowledgeSteering(taskId, binding.contractRevision);
        this.recordEvent(taskId, "composition", { provider: binding.provider, model: binding.model, baseUrl: binding.endpoint, applied: true, epoch: binding.compositionEpoch });
      },
      afterRequestBound: () => { this.steerings.delete(taskId); this.emit(taskId, { seq: 0, kind: "resync", cut: this.seqs.get(taskId) ?? 0 }); },
      acceptanceVerifiers: [async (response) => {
        const check = await acceptance.check(response?.text);
        if (check.complete) this.recordEvent(taskId, "acceptance", { ...check, criteria: contract.acceptanceCriteria, revision: contract.revision, observedAt: new Date().toISOString() });
        return check;
      }],
      verifyAfterTools: acceptance.hasFilesystemPredicate,
      waiter,
      awaitWake: async (wait) => {
        this.emit(taskId, { seq: 0, kind: "budget", budget: this.readBudget(taskId) });
        this.emit(taskId, { seq: 0, kind: "state", state: "WAITING", reason: `waiting: ${wait.condition}; keep the app open for process observations`, contractRevision: contract.revision });
        const entry = listActiveWaits(this.db, taskId).find((item) => item.waitId === wait.waitId);
        if (entry === undefined) return;
        const handle = entry.source.startsWith("process:") ? entry.source.slice("process:".length) : "";
        live.waitAbort = new AbortController();
        const signals = [live.abort.signal, live.waitAbort.signal];
        if (contract.expiresAt !== null) signals.push(AbortSignal.timeout(Math.max(1, Date.parse(contract.expiresAt) - Date.now())));
        await supervisor.waitForExit(handle, generation, AbortSignal.any(signals));
        live.waitAbort = null;
      },
      onEvent: (event) => {
        if (event.kind === "tool-end") waiter.noteToolEnd(event.tool, event.status, event.handle);
        this.onLoopEvent(taskId, live, event);
      },
      onModelText: (text) => {
        this.recordEvent(taskId, "chat", { author: "agent", text });
      },
    };
    this.setState(taskId, "RUNNING", "loop started");
    const finish = async (stop: LoopStop): Promise<LoopStop> => {
      const cleanup = await supervisor.close();
      for (const observation of cleanup) this.recordEvent(taskId, "process-cleanup", observation);
      const uncertain = cleanup.some(({ result }) => result.complete !== true || result.effectUncertain === true);
      this.onLoopStop(taskId, live, stop.decision, stop.reason, stop.wait, uncertain);
      return stop;
    };
    live.done = runTaskLoop(loopOptions).then(
      finish,
      (error: unknown) => {
        const stop = { decision: "ESCALATE" as const, reason: error instanceof Error ? error.message : "loop crashed", iterations: 0, modelCalls: 0, toolDispatches: 0 };
        return finish(stop);
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
    const apiKey = this.apiKeyFor(provider, baseUrl);
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
    _live: LiveRun,
    event: { kind: string; attemptId?: string; tool?: string; status?: string; toolCalls?: number; text?: string },
  ): void {
    if (event.kind === "wake") {
      this.setState(taskId, "RUNNING", "durable process/wake observation; continuing the same activation");
      this.recordEvent(taskId, "chat", { author: "system", text: event.text ?? "wake observed" });
      return;
    }
    if (event.kind === "model-response") {
      this.emit(taskId, { seq: 0, kind: "budget", budget: this.readBudget(taskId) });
      return;
    }
    if (event.kind === "tool-start" && event.tool !== undefined && event.attemptId !== undefined) {
      const activitySeq = this.recordEvent(taskId, "tool-activity", { attemptId: event.attemptId });
      this.emit(taskId, {
        seq: 0,
        kind: "tool",
        tool: {
          id: event.attemptId,
          seq: activitySeq,
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
      const tool = this.readTools(taskId).find((entry) => entry.id === event.attemptId);
      if (tool !== undefined) this.emit(taskId, { seq: 0, kind: "tool", tool });
    }
  }

  private applyPending(taskId: string, live: LiveRun, modelRef: NonNullable<LoopOptions["modelRef"]>): void {
    const durable = takePendingRevisions(this.db, taskId).filter((entry) => entry.payload["kind"] === "model-selection").at(-1)?.payload;
    const pending = durable === undefined ? live.pendingModel : {
      provider: String(durable["provider"]), model: String(durable["model"]), baseUrl: typeof durable["baseUrl"] === "string" ? durable["baseUrl"] : null,
    };
    if (pending === null) return;
    const adapter = this.buildAdapter(pending.provider, pending.baseUrl);
    const endpoint = normalizeEndpoint(pending.baseUrl ?? findPreset(pending.provider)?.defaultBaseUrl ?? "");
    const contract = this.contractOf(taskId);
    let revised: TaskContract | undefined;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (contract.allowedProvider !== pending.provider || contract.allowedModel !== pending.model) {
        revised = reviseContract(contract, { allowedProvider: pending.provider, allowedModel: pending.model, origin: "human model selection at safe point" });
        this.db.prepare("UPDATE contracts SET document = ?, revision = ?, updated_at = ? WHERE task_id = ?").run(JSON.stringify(revised), revised.revision, new Date().toISOString(), taskId);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (revised !== undefined) Object.assign(contract, revised);
    modelRef.provider = adapter;
    modelRef.model = pending.model;
    modelRef.providerId = pending.provider;
    modelRef.endpoint = endpoint;
    live.pendingModel = null;
  }

  private acknowledgeSteering(taskId: string, revision: number): void {
    for (const record of this.storedSteerings(taskId)) {
      if (record.state !== "accepted") continue;
      this.recordEvent(taskId, "steering-applied", { id: record.id, revision });
    }
  }

  private storedSteerings(taskId: string): StoredSteering[] {
    const cached = this.steerings.get(taskId);
    if (cached !== undefined) return cached;
    const rows = this.db.prepare("SELECT seq, kind, payload, recorded_at FROM events WHERE task_id = ? AND kind IN ('steering','steering-applied') ORDER BY seq").all(taskId) as Array<{ seq: number; kind: string; payload: string; recorded_at: string }>;
    const records: StoredSteering[] = [];
    for (const row of rows) {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      if (row.kind === "steering") records.push({ id: String(payload["id"]), seq: row.seq, text: String(payload["text"]), mode: payload["mode"] === "forbid" ? "forbid" : "guide", state: "accepted", expectedRevision: Number(payload["expectedRevision"]), appliedRevision: null, recordedAt: row.recorded_at });
      else {
        const record = records.find((entry) => entry.id === payload["id"]);
        if (record !== undefined) { record.state = "applied"; record.appliedRevision = Number(payload["revision"]); }
      }
    }
    this.steerings.set(taskId, records);
    return records;
  }

  private queueRevision(taskId: string, payload: Record<string, unknown>): void {
    const row = this.db.prepare("SELECT COALESCE(MAX(revision),0) AS revision FROM pending_revisions WHERE task_id = ?").get(taskId) as { revision: number };
    notePendingRevision(this.db, taskId, Math.max(row.revision, this.contractOf(taskId).revision) + 1, payload);
  }

  private onLoopStop(taskId: string, live: LiveRun, decision: string, reason: string, wait?: { kind: string }, cleanupUncertain = false): void {
    // A stable WAIT is not a completion: the loop already persisted the
    // WAITING/NEEDS_INPUT state, so only non-waiting outcomes transition here.
    if (wait !== undefined) {
      this.live.delete(taskId);
      const waiting: TaskState = wait.kind === "input" ? "NEEDS_INPUT" : "WAITING";
      this.emit(taskId, { seq: 0, kind: "state", state: waiting, reason, contractRevision: this.contractOf(taskId).revision });
      return;
    }
    const state: TaskState = cleanupUncertain ? "BLOCKED" : live.stopRequested
      ? "CANCELLED"
      : decision === "STOP"
        ? "COMPLETED"
        : decision === "ASK"
          ? "NEEDS_INPUT"
          : decision === "ESCALATE"
            ? "BLOCKED"
            : "CANCELLED";
    const finalReason = cleanupUncertain ? `${reason}; process cleanup remains UNKNOWN (see process-cleanup observations)` : live.stopRequested && state === "CANCELLED" ? `stop requested; ${reason}` : reason;
    this.live.delete(taskId);
    this.setState(taskId, state, finalReason);
  }

  steer(taskId: string, commandId: string, expectedRevision: number, text: string, mode: "guide" | "forbid"): CommandResult {
    const contract = this.contractOf(taskId);
    const current = this.readState(taskId);
    if (this.draining || (current.state !== "RUNNING" && current.state !== "WAITING" && current.state !== "READY" && current.state !== "NEEDS_INPUT")) {
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
    const list = this.storedSteerings(taskId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE contracts SET document = ?, revision = ?, updated_at = ? WHERE task_id = ?").run(JSON.stringify(revised), revised.revision, new Date().toISOString(), taskId);
      recordTaskEvent(this.db, taskId, "steering", { id: record.id, text: record.text, mode, expectedRevision, revision: revised.revision });
      recordTaskEvent(this.db, taskId, "chat", { author: "user", text: record.text, id: record.id });
      this.queueRevision(taskId, { kind: "steering", id: record.id, text: record.text, revision: revised.revision });
      throwIfFault("before-revision-commit");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    Object.assign(contract, revised);
    list.push(record);
    this.steerings.set(taskId, list);
    const message = this.readMessages(taskId).at(-1);
    if (message !== undefined) this.emit(taskId, { seq: 0, kind: "message", message });
    this.emit(taskId, { seq: 0, kind: "steering", steering: toSteeringView(record), contractRevision: contract.revision });
    return { accepted: true, commandId, taskId, revision: contract.revision, state: current.state };
  }

  stop(taskId: string, commandId: string): CommandResult {
    const contract = this.contractOf(taskId);
    const current = this.readState(taskId);
    const live = this.live.get(taskId);
    if (live === undefined || (current.state !== "RUNNING" && current.state !== "WAITING" && current.state !== "NEEDS_INPUT")) {
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
    if (this.draining || this.live.get(taskId) !== undefined) {
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
    if (this.draining) return { accepted: false, commandId, reason: "denied", revision: contract.revision, state };
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
      if (result.fired) this.live.get(taskId)?.waitAbort?.abort();
      return { accepted: true, commandId, taskId, revision: contract.revision, state };
    } catch {
      return { accepted: false, commandId, reason: "invalid", revision: contract.revision, state };
    }
  }

  selectModel(taskId: string, commandId: string, provider: string, model: string, baseUrl: string | null): CommandResult {
    const contract = this.contractOf(taskId);
    const current = this.readState(taskId);
    if (baseUrl !== null) {
      try { normalizeEndpoint(baseUrl); }
      catch { return { accepted: false, commandId, reason: "invalid", revision: this.safeRevision(taskId), state: this.safeState(taskId) }; }
    }
    if (this.draining) return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: current.state };
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
    if (["COMPLETED", "CANCELLED"].includes(current.state)) return { accepted: false, commandId, reason: "denied", revision: contract.revision, state: current.state };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.queueRevision(taskId, { kind: "model-selection", provider, model, baseUrl });
      recordTaskEvent(this.db, taskId, "composition", { provider, model, baseUrl, applied: false });
      throwIfFault("before-revision-commit");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (live !== undefined) live.pendingModel = { provider, model, baseUrl };
    this.emit(taskId, { seq: 0, kind: "resync", cut: this.seqs.get(taskId) ?? 0 });
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
        const rawBudget = payload["budget"];
        if (rawBudget !== undefined && (rawBudget === null || typeof rawBudget !== "object" || Array.isArray(rawBudget))) throw new Error("budget must contain calls/tokens, each a positive integer or null");
        const budget = rawBudget as BudgetGrant | undefined;
        const rawExpiry = payload["expiresAt"];
        if (rawExpiry !== undefined && rawExpiry !== null && typeof rawExpiry !== "string") throw new Error("expiresAt must be a timestamp or null");
        const rawAcceptance = payload["acceptance"];
        if (rawAcceptance !== undefined && (!Array.isArray(rawAcceptance) || rawAcceptance.some((criterion) => typeof criterion !== "string" || criterion.trim() === ""))) throw new Error("acceptance must be an array of non-empty criteria");
        const { taskId } = this.createTask({ workspace, objective, acceptance: (rawAcceptance ?? []) as string[], provider, model, baseUrl,
          ...(budget === undefined ? {} : { budget }), ...(rawExpiry === undefined ? {} : { expiresAt: rawExpiry }) });
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
        const endpoint = payload["baseUrl"];
        if (endpoint !== undefined && endpoint !== null && typeof endpoint !== "string") return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" };
        try { this.setKey(provider, key, typeof endpoint === "string" ? endpoint : null); }
        catch { return { accepted: false, commandId: command.commandId, reason: "invalid", revision: 0, state: "READY" }; }
        return { accepted: true, commandId: command.commandId, taskId: command.taskId ?? "", revision: 0, state: "READY" };
      }
    }
  }

  private pendingModelSelection(taskId: string): { provider: string; model: string; baseUrl: string | null } | null {
    const pending = takePendingRevisions(this.db, taskId).filter(entry => entry.payload["kind"] === "model-selection").at(-1)?.payload;
    if (pending === undefined) return null;
    return { provider: String(pending["provider"]), model: String(pending["model"]), baseUrl: typeof pending["baseUrl"] === "string" ? pending["baseUrl"] : null };
  }

  snapshot(taskId: string): TaskSnapshot {
    const contract = this.contractOf(taskId);
    const state = this.readState(taskId);
    const manifest = this.readManifest(taskId);
    const messages = this.readMessages(taskId);
    const tools = this.readTools(taskId);
    const verifications = this.readVerifications(taskId);
    const steering = this.storedSteerings(taskId).map(toSteeringView);
    const budget = this.readBudget(taskId);
    const unknowns = this.countUnknowns(taskId);
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
      provider: manifest.provider,
      model: manifest.model,
      baseUrl: manifest.baseUrl,
      keyConfigured: this.keyConfigured(manifest.provider, manifest.baseUrl),
      pendingModel: this.pendingModelSelection(taskId),
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
        `SELECT a.attempt_id, a.created_at, i.operation, i.target, a.state, r.outcome, r.detail, r.recorded_at,
         COALESCE((SELECT MIN(e.seq) FROM events e WHERE e.task_id = i.task_id AND e.kind = 'tool-activity' AND json_extract(e.payload, '$.attemptId') = a.attempt_id),
           (SELECT COALESCE(MAX(e.seq), 0) + 0.5 FROM events e WHERE e.task_id = i.task_id AND e.recorded_at <= a.created_at)) AS activity_seq
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
      activity_seq: number;
    }>;
    return rows.map((row) => {
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
        seq: row.activity_seq,
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
      uncertainUsageAttempts: (this.db.prepare(`SELECT COUNT(*) AS n FROM attempt_usage u JOIN attempts a ON a.attempt_id = u.attempt_id JOIN intents i ON i.intent_id = a.intent_id WHERE i.task_id = ? AND u.revision = (SELECT MAX(revision) FROM attempt_usage WHERE attempt_id = u.attempt_id) AND json_extract(u.document, '$.usageFinal') = 0`).get(taskId) as { n: number }).n,
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
    if (this.live.has(taskId)) return { canResume: false, blockers: [{ code: "active-runtime" }] };
    try {
      const report = evaluateResumeGate(
        this.db,
        { taskId, generation: this.readGeneration(), packageVersion: PACKAGE_VERSION },
        { classifyPending: false },
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
