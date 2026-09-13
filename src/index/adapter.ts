import { canonicalDay, parseExportFile } from "../telemetry/export.js";
import type { AttemptUsage } from "../telemetry/usage.js";

// Lattice-side normalization for the ranking path: an export JSONL snapshot
// becomes per-day, per-model counters in exactly the shape the Agent Index
// client consumes (date/model/input/output/cache_read/cache_write).
//
// This adapter is a fail-closed projection, never estimation:
//   - only Lattice snapshots (producer, schema, complete terminator);
//   - only final usage documents; provisional streaming rows keep the window
//     pending instead of publishing numbers that may still move;
//   - unknown quantities never become zero: the window is refused;
//   - attempts without a model or without an end timestamp are refused;
//   - cache and reasoning partitions pass through as partitions; totals use
//     input + output only, so cache is never counted twice;
//   - each physical AttemptId counts once; late corrections arrive as a new
//     export revision of the same snapshot, never as a second row.

export interface AdapterModel {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AdapterDay {
  date: string;
  models: AdapterModel[];
}

export interface AdapterCoverage {
  attempts: number;
  observed: number;
  estimated: number;
  refused: string[];
}

export interface AdapterResult {
  days: AdapterDay[];
  coverage: AdapterCoverage;
}

export class IncompleteWindowError extends Error {
  readonly reasons: string[];
  constructor(reasons: string[]) {
    super(`usage window incomplete, refusing to publish: ${reasons.join("; ")}`);
    this.name = "IncompleteWindowError";
    this.reasons = reasons;
  }
}

function quantityOrRefuse(usage: AttemptUsage, field: "inputTotal" | "outputTotal" | "cacheRead" | "cacheWrite"): number {
  const quantity = usage[field];
  // Unknown quantities never become zero: refuse the window. The extra
  // undefined check is runtime defense against malformed stored documents,
  // not a type-level possibility.
  const value: unknown = quantity.value;
  if (value === null || value === undefined) {
    throw new IncompleteWindowError([
      `attempt ${usage.attemptId} has unknown ${field}; refusing to publish zero`,
    ]);
  }
  if (typeof value !== "number") {
    throw new IncompleteWindowError([`attempt ${usage.attemptId} has a non-numeric ${field}`]);
  }
  return value;
}

function modelOf(usage: AttemptUsage): string {
  const model = usage.modelResolved ?? usage.modelRequested;
  if (model === "") {
    throw new IncompleteWindowError([`attempt ${usage.attemptId} has no model; refusing unattributed usage`]);
  }
  return model;
}

// Normalizes one export snapshot. Throws IncompleteWindowError instead of
// publishing a partial or estimated-as-final total.
export function adaptExportSnapshot(text: string): AdapterResult {
  const parsed = parseExportFile(text);
  const seen = new Set<string>();
  let observed = 0;
  let estimated = 0;
  const days = new Map<string, Map<string, AdapterModel>>();
  for (const usage of parsed.attempts) {
    if (seen.has(usage.attemptId)) {
      throw new IncompleteWindowError([`duplicate attempt ${usage.attemptId} in one snapshot`]);
    }
    seen.add(usage.attemptId);
    if (!usage.usageFinal) {
      throw new IncompleteWindowError([`attempt ${usage.attemptId} is provisional; window stays pending`]);
    }
    if (usage.finishedAt === null) {
      throw new IncompleteWindowError([`attempt ${usage.attemptId} has no end timestamp`]);
    }
    const day = canonicalDay(usage);
    if (day === null) {
      throw new IncompleteWindowError([`attempt ${usage.attemptId} has no attributable UTC day`]);
    }
    const model = modelOf(usage);
    const input = quantityOrRefuse(usage, "inputTotal");
    const output = quantityOrRefuse(usage, "outputTotal");
    const cacheRead = quantityOrRefuse(usage, "cacheRead");
    const cacheWrite = quantityOrRefuse(usage, "cacheWrite");
    const qualities = [usage.inputTotal.quality, usage.outputTotal.quality];
    if (qualities.every((quality) => quality === "observed")) observed += 1;
    else estimated += 1;
    let models = days.get(day);
    if (models === undefined) {
      models = new Map();
      days.set(day, models);
    }
    const existing = models.get(model);
    if (existing === undefined) {
      models.set(model, { model, input, output, cacheRead, cacheWrite });
    } else {
      existing.input += input;
      existing.output += output;
      existing.cacheRead += cacheRead;
      existing.cacheWrite += cacheWrite;
    }
  }
  return {
    days: [...days.entries()]
      .map(([date, models]) => ({
        date,
        models: [...models.values()].sort((a, b) => (a.model < b.model ? -1 : 1)),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    coverage: { attempts: parsed.attempts.length, observed, estimated, refused: [] },
  };
}

// Payload shape the official client posts per day, for direct comparison in
// tests: our adapter rows must equal the instrumented client payload.
export interface ClientDayPayload {
  date: string;
  models: Array<{ model: string; input: number; output: number; cache_read: number; cache_write: number }>;
}

export function toClientPayload(result: AdapterResult): ClientDayPayload[] {
  return result.days.map((day) => ({
    date: day.date,
    models: day.models.map((model) => ({
      model: model.model,
      input: model.input,
      output: model.output,
      cache_read: model.cacheRead,
      cache_write: model.cacheWrite,
    })),
  }));
}
