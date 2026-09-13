import { describe, expect, it } from "vitest";
import { initialState, uiReducer } from "../../src/ui/state.js";
import type { TaskSnapshot, UiEvent } from "../../src/server/protocol.js";

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    protocol: "ui-1",
    taskId: "task-1",
    rootId: "root-1",
    workspace: "/ws",
    objective: "Fix it",
    acceptanceCriteria: ["tests pass"],
    state: "RUNNING",
    stateReason: "",
    contractRevision: 1,
    provider: "openai",
    model: "m1",
    baseUrl: null,
    keyConfigured: false,
    unknowns: 0,
    unknownHistory: [],
    waits: [],
    resumable: false,
    resumeBlockers: [],
    budget: { grantedCalls: 50, grantedTokens: 200000, reservedCalls: 0, reservedTokens: 0, settledCalls: 0, settledTokens: 0 },
    contextUsage: { known: false },
    messages: [],
    tools: [],
    verifications: [],
    steering: [],
    cut: 3,
    ...overrides,
  };
}

describe("ui reducer", () => {
  it("applies ordered events and ignores duplicates", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    const message: UiEvent = {
      seq: 4,
      kind: "message",
      message: { id: "m1", seq: 4, author: "agent", text: "hi", recordedAt: "t" },
    };
    state = uiReducer(state, { type: "event", event: message });
    expect(state.task?.messages).toHaveLength(1);
    expect(state.lastSeq).toBe(4);
    state = uiReducer(state, { type: "event", event: message });
    expect(state.task?.messages).toHaveLength(1);
    state = uiReducer(state, { type: "event", event: { ...message, seq: 3 } });
    expect(state.task?.messages).toHaveLength(1);
  });

  it("flags resync on gaps and on resync events", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    state = uiReducer(state, {
      type: "event",
      event: { seq: 9, kind: "state", state: "RUNNING", reason: "", contractRevision: 1 },
    });
    expect(state.needsResync).toBe(true);
    expect(state.task?.state).toBe("RUNNING");
  });

  it("updates tools in place by identity, not position", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    const started: UiEvent = {
      seq: 4,
      kind: "tool",
      tool: { id: "a1", seq: 4, tool: "exec", target: null, status: "running", summary: "started", detail: null, version: null, complete: false, truncated: false, durationMs: null, recordedAt: "t" },
    };
    const ended: UiEvent = {
      seq: 5,
      kind: "tool",
      tool: { id: "a1", seq: 5, tool: "exec", target: null, status: "completed", summary: "done", detail: null, version: null, complete: true, truncated: false, durationMs: 3, recordedAt: "t" },
    };
    state = uiReducer(state, { type: "event", event: started });
    state = uiReducer(state, { type: "event", event: ended });
    expect(state.task?.tools).toHaveLength(1);
    expect(state.task?.tools[0]?.status).toBe("completed");
  });

  it("preserves draft, detail and pending commands across snapshots", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    state = uiReducer(state, { type: "draft", draft: "half written" });
    state = uiReducer(state, { type: "select-detail", detailId: "a1" });
    state = uiReducer(state, { type: "command-sent", command: { commandId: "c1", kind: "stop", text: "stop", sentAt: 1 } });
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ cut: 10 }) });
    expect(state.draft).toBe("half written");
    expect(state.detailId).toBe("a1");
    expect(state.pending).toHaveLength(1);
    expect(state.lastSeq).toBe(10);
  });

  it("clears stop echoes once a terminal state arrives", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    state = uiReducer(state, { type: "command-sent", command: { commandId: "c1", kind: "stop", text: "stop", sentAt: 1 } });
    state = uiReducer(state, { type: "event", event: { seq: 4, kind: "state", state: "CANCELLED", reason: "x", contractRevision: 1 } });
    expect(state.task?.state).toBe("CANCELLED");
    expect(state.pending).toEqual([]);
  });

  it("toggles the sidebar and tracks connection", () => {
    let state = uiReducer(initialState, { type: "toggle-sidebar" });
    expect(state.sidebarOpen).toBe(false);
    state = uiReducer(state, { type: "connection", connection: "reconnecting" });
    expect(state.connection).toBe("reconnecting");
    state = uiReducer(state, { type: "connection", connection: "live" });
    expect(state.connection).toBe("live");
    expect(state.error).toBeNull();
  });
});
