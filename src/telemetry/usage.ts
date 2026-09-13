export type QuantityQuality = "observed" | "estimated" | "unknown";

export interface TokenQuantity {
  value: number | null;
  quality: QuantityQuality;
  source: string;
  method?: string | undefined;
}

export type AttemptStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export type AttemptPurpose =
  | "primary"
  | "retry"
  | "verifier"
  | "summary"
  | "tool_auxiliary"
  | "child"
  | "wake";

export interface AttemptUsage {
  schemaVersion: 1;
  sessionId: string;
  runId: string;
  taskId: string;
  rootId: string;
  requestId: string;
  attemptId: string;
  parentAttemptId: string | null;
  intentId: string;
  executorGeneration: number;
  provider: string;
  modelRequested: string;
  modelResolved: string | null;
  adapterRevision: string | null;
  usageRevision: number;
  usageFinal: boolean;
  purpose: AttemptPurpose;
  status: AttemptStatus;
  admittedAt: string;
  dispatchedAt: string;
  firstTokenAt: string | null;
  finishedAt: string | null;
  recordedAt: string;
  clockQuality: "wall";
  durationMs: number | null;
  providerRequestId: string | null;
  error: string | null;
  inputTotal: TokenQuantity;
  inputNew: TokenQuantity;
  cacheRead: TokenQuantity;
  cacheWrite: TokenQuantity;
  outputTotal: TokenQuantity;
  reasoningSubset: TokenQuantity | null;
}

export class UsageNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageNormalizationError";
  }
}

export interface RawUsageInput {
  inputTotal?: number | null | undefined;
  inputNew?: number | null | undefined;
  cacheRead?: number | null | undefined;
  cacheWrite?: number | null | undefined;
  outputTotal?: number | null | undefined;
  reasoningSubset?: number | null | undefined;
  inclusiveInput?: boolean | undefined;
  source: string;
  estimated?: boolean;
  method?: string;
}

function checkQuantity(name: string, value: number | null | undefined): void {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new UsageNormalizationError(
      `${name} must be a non-negative integer or null; received ${String(value)}`,
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new UsageNormalizationError(`${name} exceeds safe integer range`);
  }
}

function quantity(
  value: number | null,
  source: string,
  estimated: boolean,
  method: string | undefined,
): TokenQuantity {
  if (value === null) {
    return { value: null, quality: "unknown", source };
  }
  if (value === 0) {
    return { value: 0, quality: "observed", source };
  }
  return { value, quality: estimated ? "estimated" : "observed", source, method };
}

export interface NormalizedUsage {
  inputTotal: TokenQuantity;
  inputNew: TokenQuantity;
  cacheRead: TokenQuantity;
  cacheWrite: TokenQuantity;
  outputTotal: TokenQuantity;
  reasoningSubset: TokenQuantity | null;
}

export function normalizeUsageQuantities(raw: RawUsageInput): NormalizedUsage {
  for (const [name, value] of [
    ["inputTotal", raw.inputTotal],
    ["inputNew", raw.inputNew],
    ["cacheRead", raw.cacheRead],
    ["cacheWrite", raw.cacheWrite],
    ["outputTotal", raw.outputTotal],
    ["reasoningSubset", raw.reasoningSubset],
  ] as const) {
    checkQuantity(name, value ?? null);
  }

  const estimated = raw.estimated ?? false;
  const source = raw.source;
  const total = raw.inputTotal ?? null;
  let inputNew = raw.inputNew ?? null;
  let cacheRead = raw.cacheRead ?? null;
  let cacheWrite = raw.cacheWrite ?? null;
  const outputTotal = raw.outputTotal ?? null;
  const reasoning = raw.reasoningSubset ?? null;

  if (reasoning !== null && outputTotal !== null && reasoning > outputTotal) {
    throw new UsageNormalizationError(
      `reasoningSubset (${reasoning}) is already included in outputTotal (${outputTotal}) and cannot exceed it`,
    );
  }

  if (total !== null) {
    const known = [inputNew, cacheRead, cacheWrite].filter((v) => v !== null);
    if (raw.inclusiveInput === true) {
      const read = cacheRead ?? 0;
      const write = cacheWrite ?? 0;
      if (inputNew === null) {
        const derived = total - read - write;
        if (derived < 0) {
          throw new UsageNormalizationError(
            `inclusive input partitions exceed inputTotal ${total}`,
          );
        }
        inputNew = derived;
      } else if (inputNew + read + write !== total) {
        throw new UsageNormalizationError(
          `inclusive input partitions do not sum to inputTotal ${total}`,
        );
      }
    } else if (raw.inclusiveInput === false) {
      if (inputNew !== null && cacheRead !== null && cacheWrite !== null) {
        const derived = inputNew + cacheRead + cacheWrite;
        if (derived !== total) {
          throw new UsageNormalizationError(
            `exclusive input partitions sum to ${derived}, not inputTotal ${total}`,
          );
        }
      }
    }
    if (known.length === 0) {
      inputNew = null;
      cacheRead = null;
      cacheWrite = null;
    }
  }

  return {
    inputTotal: quantity(total, source, estimated, raw.method),
    inputNew: quantity(inputNew, source, estimated, raw.method),
    cacheRead: quantity(cacheRead, source, estimated, raw.method),
    cacheWrite: quantity(cacheWrite, source, estimated, raw.method),
    outputTotal: quantity(outputTotal, source, estimated, raw.method),
    reasoningSubset: reasoning === null ? null : quantity(reasoning, source, estimated, raw.method),
  };
}

export interface RootUsageTotals {
  attempts: number;
  observed: number;
  estimated: number;
  unknown: number;
  knownInputTotal: number;
  knownOutputTotal: number;
  upperBoundTokens: number | null;
}

export function aggregateRootUsage(usages: readonly NormalizedUsage[]): RootUsageTotals {
  let observed = 0;
  let estimated = 0;
  let unknown = 0;
  let knownInputTotal = 0;
  let knownOutputTotal = 0;
  for (const usage of usages) {
    const qualities = [usage.inputTotal.quality, usage.outputTotal.quality];
    if (qualities.every((q) => q === "observed")) observed += 1;
    else if (qualities.some((q) => q === "unknown")) unknown += 1;
    else estimated += 1;
    if (usage.inputTotal.value !== null) knownInputTotal += usage.inputTotal.value;
    if (usage.outputTotal.value !== null) knownOutputTotal += usage.outputTotal.value;
  }
  return {
    attempts: usages.length,
    observed,
    estimated,
    unknown,
    knownInputTotal,
    knownOutputTotal,
    upperBoundTokens: unknown > 0 ? null : knownInputTotal + knownOutputTotal,
  };
}
