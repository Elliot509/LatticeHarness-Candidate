export const PROTOCOL_VERSION = "ui-1";

export type TaskState =
  | "READY"
  | "RUNNING"
  | "WAITING"
  | "NEEDS_INPUT"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED";

export type ToolActivityStatus =
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "timeout"
  | "unknown";

export interface MessageView {
  id: string;
  seq: number;
  author: "user" | "agent" | "system";
  text: string;
  recordedAt: string;
}

export interface ToolActivityView {
  id: string;
  seq: number;
  tool: string;
  target: string | null;
  status: ToolActivityStatus;
  summary: string;
  detail: string | null;
  version: string | null;
  complete: boolean | null;
  truncated: boolean;
  durationMs: number | null;
  recordedAt: string;
}

export interface VerificationView {
  id: string;
  seq: number;
  command: string;
  cwd: string;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  countsKnown: boolean;
  recordedAt: string;
}

export interface SteeringView {
  id: string;
  seq: number;
  text: string;
  mode: "guide" | "forbid";
  state: "received" | "accepted" | "applied";
  expectedRevision: number;
  appliedRevision: number | null;
  recordedAt: string;
}

export interface BudgetView {
  grantedCalls: number;
  grantedTokens: number;
  reservedCalls: number;
  reservedTokens: number;
  settledCalls: number;
  settledTokens: number;
}

export interface UnknownView {
  attemptId: string;
  operation: string;
  target: string | null;
  reason: string;
  recordedAt: string;
}

export interface WaitView {
  waitId: string;
  kind: string;
  condition: string;
  obligation: string;
  state: string;
}

export interface TaskSnapshot {
  protocol: typeof PROTOCOL_VERSION;
  taskId: string;
  rootId: string;
  workspace: string;
  objective: string;
  acceptanceCriteria: string[];
  state: TaskState;
  stateReason: string;
  contractRevision: number;
  provider: string;
  model: string;
  baseUrl: string | null;
  keyConfigured: boolean;
  unknowns: number;
  unknownHistory: UnknownView[];
  waits: WaitView[];
  resumable: boolean;
  resumeBlockers: string[];
  budget: BudgetView;
  contextUsage: { known: false } | { known: true; reservedTokens: number; grantedTokens: number };
  messages: MessageView[];
  tools: ToolActivityView[];
  verifications: VerificationView[];
  steering: SteeringView[];
  cut: number;
}

export type UiEvent =
  | { seq: number; kind: "message"; message: MessageView }
  | { seq: number; kind: "tool"; tool: ToolActivityView }
  | { seq: number; kind: "verification"; verification: VerificationView }
  | { seq: number; kind: "steering"; steering: SteeringView; contractRevision: number }
  | { seq: number; kind: "state"; state: TaskState; reason: string; contractRevision: number }
  | { seq: number; kind: "budget"; budget: BudgetView }
  | { seq: number; kind: "resync"; cut: number };

export type CommandKind = "create-task" | "start-task" | "steer" | "stop" | "select-model" | "set-key" | "resume-task" | "wake";

export interface UiCommand {
  commandId: string;
  kind: CommandKind;
  taskId?: string;
  expectedRevision?: number;
  payload?: Record<string, unknown>;
}

export type CommandResult =
  | { accepted: true; commandId: string; taskId: string; revision: number; state: TaskState }
  | { accepted: false; commandId: string; reason: "duplicate" | "stale" | "invalid" | "denied"; revision: number; state: TaskState };

export interface SessionSummary {
  sessionId: string;
  taskId: string;
  rootId: string;
  workspace: string;
  objective: string;
  state: TaskState;
  updatedAt: string;
}
