import {
  ProviderError,
  type ModelRequest,
  type ModelResponse,
  type ProviderAdapter,
} from "./types.js";

export const OPENAI_ADAPTER_REVISION = "openai-chat-completions-1";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAiAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

interface ChatCompletionsResponse {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  } | null;
}

function errorKind(status: number): { kind: "auth" | "rate-limited" | "server-error" | "invalid-request"; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 429) return { kind: "rate-limited", retryable: true };
  if (status >= 500) return { kind: "server-error", retryable: true };
  return { kind: "invalid-request", retryable: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

// Adapter for the OpenAI Chat Completions API (POST /chat/completions),
// per the official API reference, and for OpenAI-compatible local servers
// speaking the same endpoint. Non-streaming; one HTTP send per attempt.
// The adapter never retries: each additional send needs its own AttemptId.
// An empty API key sends no Authorization header; only use that against a
// local endpoint that needs no auth, never against the hosted API.
export class OpenAiAdapter implements ProviderAdapter {
  readonly name = "openai";
  readonly adapterRevision = OPENAI_ADAPTER_REVISION;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: OpenAiAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted === true) {
      throw new ProviderError("aborted", "OpenAI request aborted before dispatch", false);
    }
    const controller = new AbortController();
    const state = { timedOut: false };
    const timeout = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const onCallerAbort = (): void => {
      controller.abort();
    };
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      let httpResponse: Response;
      try {
        httpResponse = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey.trim() !== "" ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: request.model,
            messages: [
              { role: "system", content: request.system },
              ...request.messages.map((message) => ({
                role: message.role,
                content: message.content,
                ...(message.toolCallId !== undefined
                  ? { tool_call_id: message.toolCallId }
                  : {}),
              })),
            ],
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: "auto",
            ...(request.maxOutputTokens !== undefined
              ? { max_completion_tokens: request.maxOutputTokens }
              : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ProviderError(
            state.timedOut ? "timeout" : "aborted",
            state.timedOut ? "OpenAI request timed out" : "OpenAI request aborted",
            state.timedOut,
          );
        }
        throw new ProviderError("network", `OpenAI request failed: ${messageOf(error)}`, true);
      }
      if (!httpResponse.ok) {
        const { kind, retryable } = errorKind(httpResponse.status);
        throw new ProviderError(
          kind,
          `OpenAI request failed with status ${httpResponse.status}: ${await safeErrorText(httpResponse)}`,
          retryable,
          httpResponse.status,
        );
      }
      const body = (await httpResponse.json()) as ChatCompletionsResponse;
      return normalizeResponse(body);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

async function safeErrorText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    const parsed = asRecord(JSON.parse(text));
    const inner = parsed !== null ? asRecord(parsed["error"]) : null;
    const message = inner !== null ? inner["message"] : undefined;
    if (typeof message === "string" && message.length > 0) return message.slice(0, 500);
    return text.slice(0, 500);
  } catch {
    return "unreadable error body";
  }
}

function normalizeResponse(body: ChatCompletionsResponse): ModelResponse {
  const choice = body.choices?.[0];
  if (choice === undefined) {
    throw new ProviderError("unknown", "OpenAI response contained no choices", false);
  }
  const message = choice.message;
  if (message === undefined) {
    throw new ProviderError("unknown", "OpenAI response choice contained no message", false);
  }
  const toolCalls = (message.tool_calls ?? []).map((call, index) => {
    if (call.type !== undefined && call.type !== "function") {
      throw new ProviderError(
        "unknown",
        `Unsupported OpenAI tool call type at index ${index}`,
        false,
      );
    }
    const name = call.function?.name;
    if (typeof name !== "string" || name === "") {
      throw new ProviderError("unknown", `OpenAI tool call at index ${index} has no name`, false);
    }
    const id = typeof call.id === "string" && call.id !== "" ? call.id : `openai-call-${index}`;
    const args = call.function?.arguments;
    return { id, name, argumentsJson: typeof args === "string" ? args : "{}" };
  });
  const usage = body.usage;
  const reasoning =
    typeof usage?.completion_tokens_details?.reasoning_tokens === "number"
      ? usage.completion_tokens_details.reasoning_tokens
      : undefined;
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    usage:
      usage == null
        ? null
        : {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
          },
    modelResolved: typeof body.model === "string" ? body.model : null,
    providerRequestId: typeof body.id === "string" ? body.id : null,
  };
}
