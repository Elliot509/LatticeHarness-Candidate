import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { takePendingRevisions } from "../../src/runtime/wait.js";
import { startFixtureProvider } from "../helpers/fixture-provider.js";
import { armFault, clearFaults } from "../../src/runtime/faults.js";
import { createContract } from "../../src/runtime/contract.js";
import { admitDurable } from "../../src/runtime/effects.js";

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("fixture deadline exceeded"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

describe("actual request controls", () => {
  it("rolls back an uncommitted human revision and retains accepted pending revisions across reopen", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-revisions-"));
    const workspace = path.join(dir, "ws"); fs.mkdirSync(workspace);
    const data = path.join(dir, "data"); let db = openLatticeDb(data);
    try {
      let tasks = new TaskManager(db.raw, workspace);
      const { taskId } = tasks.createTask({ workspace: ".", objective: "Inspect", acceptance: ["response"], provider: "local", model: "m", baseUrl: null });
      armFault("before-revision-commit");
      expect(() => tasks.steer(taskId, "interrupted", 1, "must not be accepted", "guide")).toThrow("injected fault");
      clearFaults();
      expect(tasks.snapshot(taskId)).toMatchObject({ contractRevision: 1, steering: [] });
      expect(takePendingRevisions(db.raw, taskId)).toEqual([]);
      expect(tasks.steer(taskId, "accepted", 1, "durable guidance", "guide").accepted).toBe(true);
      db.close(); db = openLatticeDb(data); tasks = new TaskManager(db.raw, workspace);
      expect(tasks.snapshot(taskId).steering[0]).toMatchObject({ text: "durable guidance", state: "accepted" });
      expect(takePendingRevisions(db.raw, taskId)).toHaveLength(1);
      expect(takePendingRevisions(db.raw, taskId)).toHaveLength(1);
    } finally { clearFaults(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("denies rename destinations outside the grant and denies mismatched model authority before dispatch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-targets-"));
    const workspace = path.join(dir, "ws"); fs.mkdirSync(path.join(workspace, "source"), { recursive: true }); fs.mkdirSync(path.join(workspace, "destination"));
    const db = openLatticeDb(path.join(dir, "data"));
    try {
      const contract = createContract({ taskId: "t", rootId: "r", objective: "Inspect", scope: [workspace], acceptanceCriteria: ["response"], obligations: ["preserve work"], prohibitions: ["publish"], realm: "local-trusted", allowedProvider: "local", allowedModel: "m", expiresAt: null, retentionPolicy: "retain", origin: "fixture", grants: [{ subject: "agent", operations: ["edit", "model.invoke"], targets: ["source"], expiresAt: null, limits: { maxCalls: null, maxTokens: null } }] });
      const base = { taskId: "t", authorityRevision: 1, maxCalls: 0, maxTokens: 0, argsJson: "{}", realm: "local-trusted" };
      expect(admitDurable(db.raw, contract, { ...base, operation: "edit", target: "source/a", additionalTargets: ["destination/a"], actionKey: "rename" }, { calls: null, tokens: null }, 1, new Date(), workspace)).toMatchObject({ admitted: false, reason: "target-not-granted" });
      expect(admitDurable(db.raw, contract, { ...base, operation: "model.invoke", target: "local/other", provider: "local", model: "other", actionKey: "mismatch" }, { calls: null, tokens: null }, 1, new Date(), workspace)).toMatchObject({ admitted: false, reason: "model-not-granted" });
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toMatchObject({ n: 0 });
    } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it.each([null, 1])("binds a model switch only when the subsequent request is admitted (call cap %s), preserving older runs", async (maxCalls) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-control-"));
    const workspace = path.join(dir, "ws"); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "a"), "observed");
    const db = openLatticeDb(path.join(dir, "data"));
    const tasks = new TaskManager(db.raw, workspace);
    const received: string[] = [];
    let release = () => {};
    const first = http.createServer((req, res) => {
      let body = ""; req.on("data", chunk => { body += String(chunk); });
      req.on("end", () => {
        received.push(body);
        release = () => { if (res.writableEnded) return; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: "first", model: "m1", choices: [{ message: { content: "", tool_calls: [{ id: "read-1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } })); };
      });
    });
    await new Promise<void>(resolve => { first.listen(0, "127.0.0.1", resolve); });
    const address = first.address(); if (address === null || typeof address === "string") throw new Error("no address");
    const firstUrl = `http://127.0.0.1:${address.port}/v1`;
    const second = await startFixtureProvider([{ text: "Inspected." }]);
    try {
      const { taskId } = tasks.createTask({ workspace: ".", objective: "Inspect a", acceptance: ["response"], provider: "local", model: "m1", baseUrl: firstUrl, budget: { calls: maxCalls, tokens: null } });
      const oldRuns = db.raw.prepare("SELECT run_id, manifest FROM runs WHERE task_id = ?").all(taskId);
      expect(tasks.startTask(taskId, "start").accepted).toBe(true);
      await until(() => received.length === 1);
      const before = db.raw.prepare("SELECT total_changes() AS n").get();
      tasks.snapshot(taskId); tasks.snapshot(taskId);
      expect(db.raw.prepare("SELECT total_changes() AS n").get()).toEqual(before);
      expect(db.raw.prepare("SELECT state FROM attempts LIMIT 1").get()).toMatchObject({ state: "CLAIMED" });
      expect(tasks.steer(taskId, "guide", 1, "Preserve the Unicode café note", "guide").accepted).toBe(true);
      expect(tasks.selectModel(taskId, "switch", "local", "m2", second.url).accepted).toBe(true);
      expect(tasks.snapshot(taskId)).toMatchObject({ model: "m1", pendingModel: { model: "m2", baseUrl: second.url } });
      expect(takePendingRevisions(db.raw, taskId)).toHaveLength(2);
      expect(tasks.snapshot(taskId).steering[0]?.state).toBe("accepted");
      release();
      await until(() => tasks.snapshot(taskId).state !== "RUNNING");
      if (maxCalls === 1) {
        expect(second.requests).toHaveLength(0);
        expect(tasks.snapshot(taskId)).toMatchObject({ state: "BLOCKED", model: "m1", pendingModel: { model: "m2" } });
        expect(tasks.snapshot(taskId).steering[0]?.state).toBe("accepted");
        expect(takePendingRevisions(db.raw, taskId)).toHaveLength(2);
        return;
      }
      expect(second.requests).toHaveLength(1);
      const request = JSON.parse(second.requests[0] ?? "{}") as { model: string; messages: unknown[] };
      expect(request.model).toBe("m2");
      expect(JSON.stringify(request.messages)).toContain("Preserve the Unicode café note");
      expect(JSON.stringify(received)).not.toContain("Preserve the Unicode café note");
      expect(tasks.snapshot(taskId)).toMatchObject({ state: "COMPLETED", model: "m2", pendingModel: null });
      expect(tasks.snapshot(taskId).steering[0]?.state).toBe("applied");
      const snap = tasks.snapshot(taskId);
      const tool = snap.tools[0];
      expect(tool).toBeDefined();
      expect(snap.messages[0]?.seq).toBeLessThan(tool?.seq ?? 0);
      expect(tasks.toolDetail(taskId, tool?.id ?? "").detail).toContain("observed");
      const other = tasks.createTask({ workspace: ".", objective: "Other", acceptance: ["response"], provider: "local", model: "m2", baseUrl: second.url });
      expect(() => tasks.toolDetail(other.taskId, tool?.id ?? "")).toThrow("unknown tool result");
      expect(takePendingRevisions(db.raw, taskId)).toEqual([]);
      for (const old of oldRuns) expect(db.raw.prepare("SELECT manifest FROM runs WHERE run_id = ?").get(String(old["run_id"]))).toEqual({ manifest: old["manifest"] });
      const bindings = db.raw.prepare("SELECT payload FROM events WHERE kind = 'request-binding' ORDER BY seq").all() as Array<{ payload: string }>;
      expect(bindings).toHaveLength(2);
      expect(JSON.parse(bindings[1]?.payload ?? "{}")).toMatchObject({ provider: "local", model: "m2", endpoint: second.url });
    } finally {
      release(); await tasks.close(); db.close(); await second.close();
      await new Promise<void>(resolve => { first.close(() => resolve()); }); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
