import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { contextProvider } from "../helpers/context-provider.js";

const objective = 'Crie uma pasta chamada "Python" dentro desse lugar.';
const usage = { inputTokens: 20, outputTokens: 5, inclusiveInput: true };
async function until(check: () => boolean) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error("conversation deadline"); await new Promise(resolve => setTimeout(resolve, 5)); } }
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-conversation-")); const root = path.join(dir, "project"); fs.mkdirSync(root); const data = path.join(dir, "data"); const db = openLatticeDb(data); return { dir, root, data, db, tasks: new TaskManager(db.raw, root) }; }
const createPython = { name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "require('fs').mkdirSync('Python',{recursive:true})"] }) };

describe("persistent factual results and explicit follow-up", () => {
  it.each([false, true])("confirms existence without inventing model text or creation provenance (preexisting=%s)", async preexisting => {
    const f = fixture(); if (preexisting) fs.mkdirSync(path.join(f.root, "Python"));
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [preexisting ? { name: "read", argumentsJson: '{"kind":"directory","path":"."}' } : createPython], usage }, { text: "This model text must never be called", usage }]);
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      const task = f.tasks.snapshot(taskId); expect(task.state).toBe("COMPLETED"); expect(provider.requests).toHaveLength(1);
      expect(task.messages.filter(message => message.source === "verified")).toMatchObject([{ text: 'A pasta "Python" existe no projeto. Existência confirmada pelo Lattice.' }]);
      expect(task.messages.some(message => message.source === "model")).toBe(false); expect(fs.statSync(path.join(f.root, "Python")).isDirectory()).toBe(true);
      if (!preexisting) expect(f.tasks.toolDetail(taskId, task.tools[0]?.id ?? "").argsJson).toContain("mkdirSync");
    } finally { await f.tasks.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("retains the entire actual model final response, source and replay without duplicate SSE messages", async () => {
    const f = fixture(); const text = "Resposta longa fundamentada. ".repeat(250) + "FINAL-TAIL";
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Leia README.md e explique o conteúdo", acceptance: ["response"], provider: "local", model: "fixture", baseUrl: null });
      const observed: string[] = []; f.tasks.subscribe(taskId, event => { if (event.kind === "message") observed.push(event.message.id); });
      f.tasks.startTask(taskId, "start", new FakeProvider([{ text, usage }])); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      const messages = f.tasks.snapshot(taskId).messages.filter(message => message.author === "agent");
      expect(messages).toMatchObject([{ source: "model", text }]); expect(new Set(observed).size).toBe(observed.length);
      await f.tasks.close(); f.db.close(); const db = openLatticeDb(f.data); const reopened = new TaskManager(db.raw, f.root);
      try { expect(reopened.snapshot(taskId).messages.filter(message => message.author === "agent")).toEqual(messages); } finally { await reopened.close(); db.close(); }
    } finally { await f.tasks.close(); try { f.db.close(); } catch { /* already reopened */ } fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("keeps the newest final message beyond 500 chat events in snapshots and live projection", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Explain", acceptance: ["response"], provider: "local", model: "fixture", baseUrl: null });
      const insert = f.db.raw.prepare("INSERT INTO events(kind,task_id,payload,recorded_at) VALUES('chat',?,?,?)");
      for (let i = 0; i < 502; i++) insert.run(taskId, JSON.stringify({ author: "agent", text: `earlier-${i}`, source: "model" }), new Date().toISOString());
      const live: string[] = []; f.tasks.subscribe(taskId, event => { if (event.kind === "message") live.push(event.message.text); });
      f.tasks.startTask(taskId, "start", new FakeProvider([{ text: "latest final response", usage }])); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId).messages).toHaveLength(500); expect(f.tasks.snapshot(taskId).messages.at(-1)?.text).toBe("latest final response"); expect(live).toEqual(["latest final response"]);
    } finally { await f.tasks.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("preserves an actual model final answer for an explicit inventory-plus-response contract", async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, "known.txt"), "fictitious"); const text = "Observei known.txt. ".repeat(200) + "MODEL-FINAL-TAIL";
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Liste tudo aqui", acceptance: ["directory-listing:all:immediate:.", "response"], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [{ name: "read", argumentsJson: '{"kind":"directory","path":"."}' }], usage }, { text, usage }]);
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId).state).toBe("COMPLETED"); expect(f.tasks.snapshot(taskId).messages.find(message => message.source === "model")?.text).toBe(text); expect(f.tasks.snapshot(taskId).messages.find(message => message.source === "verified")?.text).toContain('"known.txt" [file]');
    } finally { await f.tasks.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("creates a separate authorized task, retains the first contract and makes retries durable across restart", async () => {
    const f = fixture(); const provider = await contextProvider([{ id: "fixture", context_length: 128000 }], [{ toolCalls: [{ name: "read", argumentsJson: '{"kind":"directory","path":"."}' }] }]);
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: provider.url });
      f.tasks.startTask(taskId, "first", new FakeProvider([{ toolCalls: [createPython], usage }])); await until(() => f.tasks.snapshot(taskId).state === "COMPLETED");
      const before = f.tasks.snapshot(taskId); const contract = f.db.raw.prepare("SELECT document FROM contracts WHERE task_id=?").get(taskId);
      const command = { commandId: "durable-follow-up", kind: "follow-up-task" as const, taskId, payload: { objective: "Me liste tudo que está nessa pasta." } };
      const result = f.tasks.handleCommand(command); expect(result.accepted).toBe(true); if (!result.accepted) throw new Error("follow-up refused");
      const duplicate = f.tasks.handleCommand(command); expect(duplicate).toMatchObject({ accepted: true, taskId: result.taskId });
      await until(() => f.tasks.snapshot(result.taskId).state === "COMPLETED");
      const next = f.tasks.snapshot(result.taskId); expect(next.workspace).toBe(f.root); expect(next.rootId).not.toBe(before.rootId); expect(next.model).toBe("fixture"); expect(next.baseUrl).toBe(provider.url);
      expect(next.messages[0]?.text).toBe(command.payload.objective); expect(next.messages.at(-1)).toMatchObject({ source: "verified", text: expect.stringContaining('"Python" [directory]') });
      expect(f.db.raw.prepare("SELECT document FROM contracts WHERE task_id=?").get(taskId)).toEqual(contract); expect(f.tasks.snapshot(taskId)).toEqual(before);
      expect(provider.requests).toHaveLength(1); expect(f.tasks.listSessions()).toHaveLength(2);
      expect(f.tasks.handleCommand({ ...command, payload: { objective: "different request" } }).accepted).toBe(false);
      await f.tasks.close(); f.db.close(); const db = openLatticeDb(f.data); const reopened = new TaskManager(db.raw, f.root);
      try {
        expect(reopened.handleCommand(command)).toMatchObject({ accepted: true, taskId: result.taskId, state: "COMPLETED" });
        // Broadcast cursors are process-local; durable projections are not.
        expect({ ...reopened.snapshot(result.taskId), cut: 0 }).toEqual({ ...next, cut: 0 }); expect({ ...reopened.snapshot(taskId), cut: 0 }).toEqual({ ...before, cut: 0 }); expect(reopened.listSessions()).toHaveLength(2); expect(provider.requests).toHaveLength(1);
      } finally { await reopened.close(); db.close(); }
    } finally { await provider.close(); await f.tasks.close(); try { f.db.close(); } catch { /* closed by persistence probe */ } fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
});
