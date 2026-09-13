// Model discovery and connection testing over OpenAI-compatible endpoints.
//
// Both operations are GET {baseUrl}/models with no request body, no model
// call and no retries: a metadata read only. Failures are classified so the
// UI can tell timeout, auth denial, provider incompatibility and partial
// responses apart instead of inventing "connected".

export interface DiscoveredModel {
  /** Canonical id sent as `model` in chat requests. */
  id: string;
  /** Optional display hint; never a substitute for the id. */
  displayName: string | null;
  ownedBy: string | null;
}

export type DiscoveryOutcome =
  | { ok: true; models: DiscoveredModel[]; source: "models-endpoint" }
  | { ok: false; kind: "auth" | "timeout" | "network" | "incompatible" | "invalid" | "partial"; detail: string };

export interface DiscoveryOptions {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 15_000;
const MAX_MODELS = 500;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function normalizeModels(payload: unknown): DiscoveredModel[] | null {
  const root = asRecord(payload);
  const data = root?.["data"];
  if (!Array.isArray(data)) return null;
  const models: DiscoveredModel[] = [];
  for (const entry of data.slice(0, MAX_MODELS)) {
    const record = asRecord(entry);
    const id = record?.["id"];
    if (typeof id !== "string" || id.trim() === "") continue;
    const displayName = record?.["name"];
    const ownedBy = record?.["owned_by"] ?? record?.["ownedBy"];
    models.push({
      id: id.trim(),
      displayName: typeof displayName === "string" && displayName.trim() !== "" ? displayName.trim() : null,
      ownedBy: typeof ownedBy === "string" && ownedBy.trim() !== "" ? ownedBy.trim() : null,
    });
  }
  return models;
}

/**
 * List models from an OpenAI-compatible endpoint. Never sends a secret in
 * the URL; the key travels only as a Bearer header, and only when provided
 * (local endpoints may need none). One HTTP send, no retries, no fallback.
 */
export async function listModels(options: DiscoveryOptions): Promise<DiscoveryOutcome> {
  const base = options.baseUrl.trim().replace(/\/+$/, "");
  if (base === "") {
    return { ok: false, kind: "invalid", detail: "base URL is empty" };
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const state = { timedOut: false };
  const timeout = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/models`, {
        method: "GET",
        headers: {
          ...(options.apiKey !== undefined && options.apiKey.trim() !== "" ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (state.timedOut || (error instanceof Error && error.name === "AbortError")) {
        return { ok: false, kind: "timeout", detail: `models request timed out` };
      }
      return { ok: false, kind: "network", detail: error instanceof Error ? error.message : "network failure" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: "auth", detail: `endpoint denied the credential (http ${response.status})` };
    }
    if (response.status === 404 || response.status === 405) {
      return { ok: false, kind: "incompatible", detail: `endpoint has no models listing (http ${response.status}); enter the model id manually` };
    }
    if (!response.ok) {
      return { ok: false, kind: "invalid", detail: `endpoint answered http ${response.status}` };
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, kind: "partial", detail: "endpoint answered with a non-JSON body" };
    }
    const models = normalizeModels(payload);
    if (models === null) {
      return { ok: false, kind: "partial", detail: "endpoint answered without a model data array" };
    }
    return { ok: true, models, source: "models-endpoint" };
  } finally {
    clearTimeout(timeout);
  }
}

export interface ConnectionTest {
  ok: boolean;
  kind: "reachable" | "auth" | "timeout" | "network" | "incompatible" | "invalid" | "partial";
  modelCount: number;
  detail: string;
}

/**
 * Factual connection test: exactly one metadata read, reported as-is.
 * A reachable endpoint with an empty-but-valid list is reachable, not a
 * failure. Never marks success from a mere well-formed URL.
 */
export async function testConnection(options: DiscoveryOptions): Promise<ConnectionTest> {
  const outcome = await listModels(options);
  if (outcome.ok) {
    return {
      ok: true,
      kind: "reachable",
      modelCount: outcome.models.length,
      detail: outcome.models.length === 0 ? "endpoint reachable; it reports no models" : `endpoint reachable; ${outcome.models.length} model(s) listed`,
    };
  }
  return { ok: false, kind: outcome.kind, modelCount: 0, detail: outcome.detail };
}
