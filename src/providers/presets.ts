// Provider presets for S5 productization.
//
// A preset is configuration UX for a known service, NOT a protocol
// implementation. Every preset below speaks OpenAI Chat Completions over
// HTTPS (or loopback HTTP for Local/Custom) and is served by the single
// OpenAiAdapter in ./openai.ts. A new adapter is only justified by a proven
// protocol incompatibility, never by a new brand name.
//
// Evidence (consulted 13/09/2026):
// - OpenAI: official OpenAPI v2.3.0 — GET /models returns
//   {object:"list", data:[{id,...}]}, Bearer auth, Chat Completions + tools.
// - OpenRouter: official API reference — base https://openrouter.ai/api/v1,
//   Bearer + optional HTTP-Referer / X-Title, OpenAI-normalized schema
//   including tools, model catalog available.
// - Google AI Studio (Gemini): official "OpenAI compatibility" docs — base
//   https://generativelanguage.googleapis.com/v1beta/openai/, Bearer
//   GEMINI_API_KEY, chat/streaming/function calling. Model listing on the
//   compat path is unconfirmed: discovery is best-effort here.
// - Abacus.AI RouteLLM (self-serve): official docs — base
//   https://routellm.abacus.ai/v1, Bearer, fully OpenAI-compatible
//   /v1/chat/completions (streaming, tools, structured outputs) plus
//   GET /v1/models and a `route-llm` auto model. Enterprise workspaces use
//   https://<workspace>.abacus.ai/v1 and are configured via Custom.
// - Local: llama.cpp `llama-server` exposes GET /v1/models (id defaults to
//   the model path; friendlier with --alias), optional Bearer when started
//   with --api-key, standard usage object. Tool calling depends on the
//   served model/template and is NOT guaranteed: the preset documents the
//   caveat instead of promising it. No weight management in S5.

export const KNOWN_PROTOCOL = "openai-compatible" as const;

export type ModelListSupport = "yes" | "best-effort";

export interface ProviderPreset {
  /** Stable id used in TaskContract allowedProvider and credential refs. */
  id: string;
  /** Human label. Never shown as authority, only as choice. */
  displayName: string;
  /** Always "openai-compatible" in S5: one adapter serves all presets. */
  protocol: typeof KNOWN_PROTOCOL;
  defaultBaseUrl: string;
  /** True when the service requires a key for every call. */
  keyRequired: boolean;
  /** Label shown next to the credential field. */
  keyLabel: string;
  /** Whether GET {base}/models is expected to work. */
  modelList: ModelListSupport;
  /** Short, honest usage note shown in Settings. */
  note: string;
  /** Official documentation URL backing this preset. */
  docsUrl: string;
}

const PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    displayName: "OpenAI",
    protocol: KNOWN_PROTOCOL,
    defaultBaseUrl: "https://api.openai.com/v1",
    keyRequired: true,
    keyLabel: "Chave de API OpenAI",
    modelList: "yes",
    note: "Chat Completions + tools pelo protocolo oficial.",
    docsUrl: "https://developers.openai.com/api/reference/chat-completions/overview",
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    protocol: KNOWN_PROTOCOL,
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyRequired: true,
    keyLabel: "Chave de API OpenRouter",
    modelList: "yes",
    note: "Um endpoint para vários modelos; schema normalizado OpenAI, tools onde o modelo suporta.",
    docsUrl: "https://openrouter.ai/docs/api/reference",
  },
  {
    id: "gemini",
    displayName: "Google AI Studio",
    protocol: KNOWN_PROTOCOL,
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    keyRequired: true,
    keyLabel: "Chave de API Gemini",
    modelList: "best-effort",
    note: "Compatibilidade OpenAI do Gemini (chat, streaming, function calling). Listagem de modelos pode exigir ID manual.",
    docsUrl: "https://ai.google.dev/gemini-api/docs/openai",
  },
  {
    id: "abacus",
    displayName: "Abacus RouteLLM",
    protocol: KNOWN_PROTOCOL,
    defaultBaseUrl: "https://routellm.abacus.ai/v1",
    keyRequired: true,
    keyLabel: "Chave de API Abacus",
    modelList: "yes",
    note: "Self-serve; Enterprise usa workspace próprio via Custom. `route-llm` escolhe o modelo no servidor.",
    docsUrl: "https://abacus.ai/help/developer-platform/route-llm/chat-completions",
  },
  {
    id: "local",
    displayName: "Local",
    protocol: KNOWN_PROTOCOL,
    defaultBaseUrl: "http://127.0.0.1:8080/v1",
    keyRequired: false,
    keyLabel: "Chave (só se o servidor exigir)",
    modelList: "yes",
    note: "Servidor OpenAI-compatible local (ex. llama-server). Sem gerenciar pesos. Tool calling depende do modelo servido.",
    docsUrl: "https://llama.app/docs/api",
  },
];

export function listPresets(): ProviderPreset[] {
  return PRESETS.map((preset) => ({ ...preset }));
}

export function findPreset(id: string): ProviderPreset | null {
  return PRESETS.find((preset) => preset.id === id) ?? null;
}

export function isKnownProviderId(id: unknown): boolean {
  return typeof id === "string" && (id === "custom" || findPreset(id) !== null);
}

export interface CustomPresetInput {
  displayName: string;
  baseUrl: string;
  keyRequired: boolean;
}

function validatedBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("base URL must be a valid http(s) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("base URL must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("base URL must not embed credentials");
  }
  return trimmed.replace(/\/+$/, "");
}

export function buildCustomPreset(input: CustomPresetInput): ProviderPreset {
  if (input.displayName.trim() === "") {
    throw new Error("custom provider needs a display name");
  }
  return {
    id: "custom",
    displayName: input.displayName.trim(),
    protocol: KNOWN_PROTOCOL,
    defaultBaseUrl: validatedBaseUrl(input.baseUrl),
    keyRequired: input.keyRequired,
    keyLabel: "Chave de API",
    modelList: "best-effort",
    note: "Endpoint OpenAI-compatible arbitrário. Listagem e tools dependem do servidor.",
    docsUrl: "",
  };
}

/** Resolve the effective base URL for a provider: explicit value wins. */
export function resolveBaseUrl(preset: ProviderPreset, override: string | null): string {
  if (override !== null && override.trim() !== "") {
    return validatedBaseUrl(override);
  }
  return preset.defaultBaseUrl;
}
