import type { ToolDefinition } from "../providers/types.js";

export type ToolStatus =
  | "completed"
  | "running"
  | "denied"
  | "cancelled"
  | "timeout"
  | "unknown";

export interface ToolResult {
  status: ToolStatus;
  summary: string;
  detail?: string;
  version?: string;
  complete?: boolean;
  truncated?: boolean;
  truncationNote?: string;
  handleId?: string;
  errorKind?: string;
  errorRetryable?: boolean;
  effectUncertain?: boolean;
}

export interface ToolContext {
  workspaceRoot: string;
  realm: string;
  timeoutMs?: number;
}

export interface Tool<TArgs> {
  readonly definition: ToolDefinition;
  execute(args: TArgs, context: ToolContext): Promise<ToolResult>;
}

export function toolFailure(kind: string, summary: string, retryable: boolean): ToolResult {
  return { status: "completed", summary, errorKind: kind, errorRetryable: retryable };
}

export function parseToolArgs(json: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "tool arguments are not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "tool arguments must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
