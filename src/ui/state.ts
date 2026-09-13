import type {
  SessionSummary,
  TaskSnapshot,
  TaskState,
  UiEvent,
} from "../server/protocol.js";

export type ConnectionState = "loading" | "live" | "reconnecting" | "error";

export interface PendingCommand {
  commandId: string;
  kind: string;
  text: string;
  sentAt: number;
}

export type UiView = "task" | "settings" | "help";

export interface UiState {
  connection: ConnectionState;
  sessions: SessionSummary[];
  activeTaskId: string | null;
  task: TaskSnapshot | null;
  lastSeq: number;
  seenIds: string[];
  draft: string;
  detailId: string | null;
  sidebarOpen: boolean;
  pending: PendingCommand[];
  error: string | null;
  needsResync: boolean;
  view: UiView;
  sessionFilter: string;
}

export const initialState: UiState = {
  connection: "loading",
  sessions: [],
  activeTaskId: null,
  task: null,
  lastSeq: 0,
  seenIds: [],
  draft: "",
  detailId: null,
  sidebarOpen: true,
  pending: [],
  error: null,
  needsResync: false,
  view: "task",
  sessionFilter: "",
};

export type UiAction =
  | { type: "sessions"; sessions: SessionSummary[] }
  | { type: "open-task"; taskId: string }
  | { type: "snapshot"; snapshot: TaskSnapshot }
  | { type: "event"; event: UiEvent }
  | { type: "connection"; connection: ConnectionState; error?: string }
  | { type: "request-resync" }
  | { type: "draft"; draft: string }
  | { type: "select-detail"; detailId: string | null }
  | { type: "toggle-sidebar" }
  | { type: "command-sent"; command: PendingCommand }
  | { type: "set-view"; view: UiView }
  | { type: "session-filter"; filter: string }
  | { type: "clear-task" };

export function uiReducer(state: UiState, action: UiAction): UiState {
  switch (action.type) {
    case "sessions":
      return { ...state, sessions: action.sessions };
    case "open-task":
      return {
        ...state,
        activeTaskId: action.taskId,
        task: null,
        lastSeq: 0,
        seenIds: [],
        detailId: null,
        pending: [],
        error: null,
        needsResync: false,
        connection: "loading",
      };
    case "snapshot": {
      // Snapshot replaces projections but never the local draft, the open
      // detail, the sidebar or pending command echoes.
      const lastSeq = action.snapshot.cut;
      const seenIds = action.snapshot.messages.map((m) => m.id)
        .concat(action.snapshot.tools.map((t) => t.id))
        .concat(action.snapshot.verifications.map((v) => v.id))
        .concat(action.snapshot.steering.map((s) => s.id));
      const pending = state.pending.filter((command) => {
        if (command.kind !== "steer" && command.kind !== "stop") return true;
        if (command.kind === "stop") {
          return action.snapshot.state === "RUNNING";
        }
        return !action.snapshot.steering.some((entry) => entry.text === command.text);
      });
      return {
        ...state,
        task: action.snapshot,
        lastSeq,
        seenIds,
        pending,
        needsResync: false,
        error: null,
      };
    }
    case "event": {
      const event = action.event;
      if (event.seq <= state.lastSeq) return state;
      if (event.seq > state.lastSeq + 1) return { ...state, needsResync: true };
      if (event.kind === "resync") return { ...state, needsResync: true };
      if (state.task === null) return { ...state, lastSeq: event.seq };
      const task = applyEvent(state.task, event);
      if (task === null) return { ...state, lastSeq: event.seq };
      const pending =
        event.kind === "state" && (event.state === "CANCELLED" || event.state === "COMPLETED" || event.state === "BLOCKED")
          ? state.pending.filter((command) => command.kind !== "stop")
          : state.pending;
      return { ...state, task, lastSeq: event.seq, pending };
    }
    case "connection":
      return {
        ...state,
        connection: action.connection,
        error: action.error ?? (action.connection === "live" ? null : state.error),
      };
    case "request-resync":
      return { ...state, needsResync: true };
    case "draft":
      return { ...state, draft: action.draft };
    case "select-detail":
      return { ...state, detailId: action.detailId };
    case "toggle-sidebar":
      return { ...state, sidebarOpen: !state.sidebarOpen };
    case "command-sent":
      return { ...state, pending: [...state.pending, action.command] };
    case "set-view":
      return { ...state, view: action.view };
    case "session-filter":
      return { ...state, sessionFilter: action.filter };
    case "clear-task":
      return { ...state, activeTaskId: null, task: null, pending: [], detailId: null, view: "task" };
  }
}

function applyEvent(task: TaskSnapshot, event: UiEvent): TaskSnapshot | null {
  switch (event.kind) {
    case "message":
      if (task.messages.some((m) => m.id === event.message.id)) return task;
      return { ...task, messages: [...task.messages, event.message], cut: event.seq };
    case "tool": {
      const index = task.tools.findIndex((t) => t.id === event.tool.id);
      if (index === -1) return { ...task, tools: [...task.tools, event.tool], cut: event.seq };
      const tools = [...task.tools];
      tools[index] = event.tool;
      return { ...task, tools, cut: event.seq };
    }
    case "verification":
      if (task.verifications.some((v) => v.id === event.verification.id)) return task;
      return { ...task, verifications: [...task.verifications, event.verification], cut: event.seq };
    case "steering": {
      const index = task.steering.findIndex((s) => s.id === event.steering.id);
      if (index === -1) {
        return { ...task, steering: [...task.steering, event.steering], contractRevision: event.contractRevision, cut: event.seq };
      }
      const steering = [...task.steering];
      steering[index] = event.steering;
      return { ...task, steering, contractRevision: event.contractRevision, cut: event.seq };
    }
    case "state":
      return { ...task, state: event.state, stateReason: event.reason, contractRevision: event.contractRevision, cut: event.seq };
    case "budget":
      return { ...task, budget: event.budget, cut: event.seq };
    case "resync":
      return task;
  }
}

export function stateLabel(state: TaskState): string {
  switch (state) {
    case "READY":
      return "Pronto";
    case "RUNNING":
      return "Em execução";
    case "WAITING":
      return "Aguardando";
    case "NEEDS_INPUT":
      return "Precisa de resposta";
    case "BLOCKED":
      return "Bloqueado";
    case "COMPLETED":
      return "Concluído";
    case "CANCELLED":
      return "Interrompido";
  }
}

export function toolStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "em execução";
    case "completed":
      return "concluído";
    case "failed":
      return "falhou";
    case "denied":
      return "negado";
    case "cancelled":
      return "interrompido";
    case "timeout":
      return "expirou";
    case "unknown":
      return "incerto";
    default:
      return status;
  }
}
