import type { DatabaseSync } from "node:sqlite";
import { listModels, type DiscoveryOutcome } from "../providers/discovery.js";
import { normalizeEndpoint } from "../providers/endpoint.js";
import { findPreset } from "../providers/presets.js";
import type { ContextUsage } from "./protocol.js";

type Selection = { provider: string; model: string; baseUrl: string | null };
type Route = { provider: string; endpoint: string; model: string };
interface Capacity extends Route { contextLength: number | null; observedAt: number }
const TTL_MS = 5 * 60_000;

function endpoint(selection: Selection): string {
  return normalizeEndpoint(selection.baseUrl ?? findPreset(selection.provider)?.defaultBaseUrl ?? "");
}

// A read projection and optional metadata side channel. No loop, budget,
// admission, receipt or schema changes. Persist only small provider facts.
export class ContextTracker {
  private readonly catalogs = new Map<string, { at: number; result: Promise<DiscoveryOutcome> }>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync) { this.db = db; }

  invalidate(): void { this.catalogs.clear(); }
  async close(): Promise<void> { this.abort.abort(); await Promise.allSettled(this.pending.values()); }

  catalog(provider: string, baseUrl: string, apiKey: string, force = false): Promise<DiscoveryOutcome> {
    const base = normalizeEndpoint(baseUrl);
    const key = JSON.stringify([provider, base]);
    const cached = this.catalogs.get(key);
    if (!force && cached !== undefined && Date.now() - cached.at < TTL_MS) return cached.result;
    if (this.catalogs.size >= 32) { const first = this.catalogs.keys().next(); if (!first.done) this.catalogs.delete(first.value); }
    const result = listModels({ baseUrl: base, apiKey, signal: this.abort.signal });
    this.catalogs.set(key, { at: Date.now(), result });
    return result;
  }

  private sample(taskId: string, selection: Selection): { route: Route; usedTokens?: number; attemptId?: string } {
    const route = { provider: selection.provider, endpoint: endpoint(selection), model: selection.model };
    // Binding seq defines request order even when wall clocks/timestamps tie.
    // Skip unknown/cancelled samples, not confirmed input just because output
    // or cache partitions are unavailable. inputTotal already includes cache.
    const row = this.db.prepare(`SELECT u.document, b.payload FROM attempt_usage u
      JOIN attempts a ON a.attempt_id = u.attempt_id JOIN intents i ON i.intent_id = a.intent_id
      JOIN receipts r ON r.attempt_id = a.attempt_id AND r.outcome = 'confirmed'
      JOIN events b ON b.task_id = i.task_id AND b.kind = 'request-binding'
        AND json_extract(b.payload, '$.attemptId') = a.attempt_id
      WHERE i.task_id = ? AND i.operation = 'model.invoke'
        AND json_extract(u.document, '$.status') = 'completed'
        AND json_extract(u.document, '$.inputTotal.quality') = 'observed'
        AND json_type(u.document, '$.inputTotal.value') = 'integer'
        AND json_extract(u.document, '$.inputTotal.value') >= 0
      ORDER BY b.seq DESC LIMIT 1`).get(taskId) as { document: string; payload: string } | undefined;
    if (row === undefined) return { route };
    const usage = JSON.parse(row.document) as { provider: string; modelRequested: string; modelResolved: string | null; attemptId: string; inputTotal: { value: number } };
    const binding = JSON.parse(row.payload) as { provider: string; model: string; endpoint: string | null };
    if (usage.provider !== route.provider || binding.provider !== route.provider || usage.modelRequested !== route.model
      || binding.model !== route.model || binding.endpoint !== route.endpoint || !Number.isSafeInteger(usage.inputTotal.value)) return { route };
    return { route: { ...route, model: usage.modelResolved?.trim() || route.model }, usedTokens: usage.inputTotal.value, attemptId: usage.attemptId };
  }

  private capacity(taskId: string, route: Route): Capacity | null {
    const row = this.db.prepare(`SELECT payload FROM events WHERE task_id = ? AND kind = 'model-context'
      AND json_extract(payload, '$.provider') = ? AND json_extract(payload, '$.endpoint') = ?
      AND json_extract(payload, '$.model') = ? ORDER BY seq DESC LIMIT 1`).get(taskId, route.provider, route.endpoint, route.model) as { payload: string } | undefined;
    return row === undefined ? null : JSON.parse(row.payload) as Capacity;
  }

  read(taskId: string, selection: Selection): ContextUsage {
    try { return this.project(taskId, selection); }
    catch { return { known: false }; } // Bad historical metadata is never a loop failure.
  }

  private project(taskId: string, selection: Selection): ContextUsage {
    const sample = this.sample(taskId, selection);
    const capacity = this.capacity(taskId, sample.route);
    const window = capacity?.contextLength;
    const used = sample.usedTokens;
    if (used === undefined && (typeof window !== "number" || !Number.isSafeInteger(window) || window <= 0)) return { known: false };
    const facts = { ...sample.route, ...(sample.attemptId === undefined ? {} : { attemptId: sample.attemptId }),
      ...(typeof window === "number" && Number.isSafeInteger(window) && window > 0 ? { contextWindow: window, capacitySource: "models-endpoint.context_length" as const, capacityKind: "nominal" as const } : {}),
      ...(used === undefined ? {} : { usedTokens: used }) };
    if (facts.contextWindow !== undefined && used !== undefined) return { ...facts, known: true, contextWindow: facts.contextWindow, usedTokens: used };
    return { ...facts, known: false };
  }

  refresh(taskId: string, selection: Selection, apiKey: string, updated: () => void): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    const { route } = this.sample(taskId, selection);
    const old = this.capacity(taskId, route);
    if (old !== null && Date.now() - old.observedAt < TTL_MS) return Promise.resolve();
    const key = JSON.stringify([taskId, route]);
    const pending = this.pending.get(key); if (pending !== undefined) return pending;
    const work = this.catalog(route.provider, route.endpoint, apiKey).then(result => {
      if (this.abort.signal.aborted) return;
      const matches = result.ok ? result.models.filter(model => model.id === route.model) : [];
      // Duplicate/contradictory ids are not reliable model metadata.
      const contextLength = matches.length === 1 ? matches[0]?.contextLength ?? null : null;
      const capacity: Capacity = { ...route, contextLength, observedAt: Date.now() };
      this.db.prepare("INSERT INTO events(kind,task_id,payload,recorded_at) VALUES('model-context',?,?,?)")
        .run(taskId, JSON.stringify(capacity), new Date().toISOString());
      updated();
    }).finally(() => { this.pending.delete(key); });
    this.pending.set(key, work);
    return work;
  }
}
