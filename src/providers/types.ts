export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface RawUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
  [key: string]: unknown;
}

export interface ModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  usage: RawUsage | null;
  modelResolved: string | null;
  providerRequestId: string | null;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export type ProviderErrorKind =
  | "auth"
  | "rate-limited"
  | "server-error"
  | "network"
  | "timeout"
  | "aborted"
  | "invalid-request"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  constructor(kind: ProviderErrorKind, message: string, retryable: boolean, statusCode: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryable = retryable;
    this.statusCode = statusCode;
  }
}

export interface ProviderAdapter {
  readonly name: string;
  readonly adapterRevision: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
