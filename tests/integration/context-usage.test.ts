import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { contextProvider, type ContextStep } from "../helpers/context-provider.js";

async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() > end) throw new Error("context fixture deadline"); await new Promise(resolve => setTimeout(resolve, 5)); }
}

async function run(steps: ContextStep[], models: unknown[] = [{ id: "manual/model", context_length: 128000 }], model = "manual/model") {
  const provider = await contextProvider(models, steps);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-context-")); fs.writeFileSync(path.join(dir, "note"), "observed");
  let db = openLatticeDb(path.join(dir, "data")); let tasks = new TaskManager(db.raw, dir);
  const { taskId } = tasks.createTask({ objective: "Inspect", acceptance: ["response"], workspace: ".", provider: "local", model, baseUrl: provider.url });
  await tasks.refreshContext(taskId);
  tasks.startTask(taskId, "start"); await until(() => tasks.snapshot(taskId).state !== "RUNNING"); await tasks.refreshContext(taskId);
  return { provider, dir, taskId, get db() { return db; }, get tasks() { return tasks; },
    reopen: async () => { await tasks.close(); db.close(); db = openLatticeDb(path.join(dir, "data")); tasks = new TaskManager(db.raw, dir); },
    close: async () => { await tasks.close(); db.close(); await provider.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const read = { name: "read", argumentsJson: '{"path":"note"}' };

describe("context from model facts and durable completed input", () => {
  it("finds a manual model beyond 500, uses inclusive prompt input and persists without a new metadata request", async () => {
    const f = await run([{ text: "Analysis", usage: { prompt_tokens: 1900, completion_tokens: 900, prompt_tokens_details: { cached_tokens: 1700, cache_write_tokens: 100 } } }], [...Array.from({ length: 501 }, (_, i) => ({ id: `other-${i}` })), { id: "manual/model", context_length: 128000, top_provider: { context_length: 32000 } }]);
    try {
      const before = f.tasks.snapshot(f.taskId).contextUsage;
      expect(before).toMatchObject({ known: true, usedTokens: 1900, contextWindow: 128000, model: "manual/model", endpoint: f.provider.url, provider: "local", capacityKind: "nominal" });
      expect(f.tasks.snapshot(f.taskId).budget.settledTokens).toBe(2800);
      expect(f.provider.catalogReads).toBe(1);
      await f.reopen(); await f.tasks.refreshContext(f.taskId);
      expect(f.tasks.snapshot(f.taskId).contextUsage).toEqual(before); expect(f.provider.catalogReads).toBe(1);
      const writes = f.db.raw.prepare("SELECT total_changes() AS n").get(); f.tasks.snapshot(f.taskId);
      expect(f.db.raw.prepare("SELECT total_changes() AS n").get()).toEqual(writes);
    } finally { await f.close(); }
  });

  it("updates after each completed call, even with partial cache/output telemetry", async () => {
    const f = await run([{ toolCalls: [read], usage: { prompt_tokens: 1100, completion_tokens: 20 } }, { text: "Analysis", usage: { prompt_tokens: 2300, prompt_tokens_details: { cached_tokens: 2100 } } }]);
    try { expect(f.tasks.snapshot(f.taskId).contextUsage).toMatchObject({ known: true, usedTokens: 2300, contextWindow: 128000 }); expect(f.provider.catalogReads).toBe(1); }
    finally { await f.close(); }
  });

  it.each([null, { prompt_tokens: "1900" }, { prompt_tokens: -1 }, { completion_tokens: 40 }])("keeps confirmed input when a later call has unknown/invalid input %s", async usage => {
    const f = await run([{ toolCalls: [read], usage: { prompt_tokens: 1100, completion_tokens: 20 } }, { text: "Analysis", usage }]);
    try { expect(f.tasks.snapshot(f.taskId).contextUsage).toMatchObject({ known: true, usedTokens: 1100 }); }
    finally { await f.close(); }
  });

  it.each([undefined, null, 0, -1, 1.5, "128000", Number.MAX_SAFE_INTEGER + 1])("never guesses invalid/missing metadata %s", async context_length => {
    const f = await run([{ text: "Analysis" }], [{ id: "manual/model", context_length, top_provider: { context_length: 32000 } }]);
    try { expect(f.tasks.snapshot(f.taskId).contextUsage).toMatchObject({ known: false, usedTokens: 1900 }); expect(f.tasks.snapshot(f.taskId).contextUsage.contextWindow).toBeUndefined(); }
    finally { await f.close(); }
  });

  it("uses the resolved model's metadata instead of a requested alias", async () => {
    const f = await run([{ text: "Analysis", model: "actual/model" }], [{ id: "manual/model", context_length: 128000 }, { id: "actual/model", context_length: 64000 }]);
    try { expect(f.tasks.snapshot(f.taskId).contextUsage).toMatchObject({ known: true, model: "actual/model", contextWindow: 64000 }); expect(f.provider.catalogReads).toBe(1); }
    finally { await f.close(); }
  });

  it("does not reuse the requested alias capacity when the resolved model is missing", async () => {
    const f = await run([{ text: "Analysis", model: "unknown/resolved" }]);
    try { expect(f.tasks.snapshot(f.taskId).contextUsage).toMatchObject({ known: false, model: "unknown/resolved", usedTokens: 1900 }); expect(f.tasks.snapshot(f.taskId).contextUsage.contextWindow).toBeUndefined(); }
    finally { await f.close(); }
  });

  it("does not invent input from output-only usage", async () => {
    const f = await run([{ text: "Analysis", usage: { completion_tokens: 1900 } }]);
    try { expect(f.tasks.snapshot(f.taskId).contextUsage).toMatchObject({ known: false, contextWindow: 128000 }); expect(f.tasks.snapshot(f.taskId).contextUsage.usedTokens).toBeUndefined(); }
    finally { await f.close(); }
  });

  it("rejects estimated input rather than replacing an observed sample", async () => {
    const f = await run([{ toolCalls: [read], usage: { prompt_tokens: 1100, completion_tokens: 20 } }, { text: "Analysis" }]);
    try {
      const latest = f.db.raw.prepare("SELECT u.attempt_id FROM attempt_usage u JOIN events e ON e.kind='request-binding' AND json_extract(e.payload,'$.attemptId')=u.attempt_id ORDER BY e.seq DESC LIMIT 1").get() as { attempt_id: string };
      f.db.raw.prepare("UPDATE attempt_usage SET document=json_set(document,'$.inputTotal.quality','estimated','$.inputTotal.value',99999) WHERE attempt_id=?").run(latest.attempt_id);
      expect(f.tasks.snapshot(f.taskId).contextUsage).toMatchObject({ known: true, usedTokens: 1100 });
    } finally { await f.close(); }
  });

  it("accepts an observed zero and rejects contradictory catalog identities", async () => {
    const f = await run([{ text: "Analysis", usage: { prompt_tokens: 0 } }], [{ id: "manual/model", context_length: 128000 }, { id: "manual/model", context_length: 32000 }]);
    try { expect(f.tasks.snapshot(f.taskId).contextUsage).toMatchObject({ known: false, usedTokens: 0 }); expect(f.tasks.snapshot(f.taskId).contextUsage.contextWindow).toBeUndefined(); }
    finally { await f.close(); }
  });

  it("fails closed on corrupt historical metadata without changing the task", async () => {
    const f = await run([{ text: "Analysis" }]);
    try {
      f.db.raw.prepare("UPDATE events SET payload='not-json' WHERE kind='model-context'").run();
      expect(f.tasks.snapshot(f.taskId)).toMatchObject({ state: "COMPLETED", contextUsage: { known: false } });
      expect(f.provider.requests).toHaveLength(1);
    } finally { await f.close(); }
  });
});

describe("effective route and cancellation", () => {
  it.each([{ provider: "local", model: "m1" }, { provider: "local", model: "m2" }, { provider: "custom", model: "m2" }])("switches metadata only with the admitted route: %s", async next => {
    let releaseFirst = () => {}; let releaseSecond = () => {};
    const firstWait = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondWait = new Promise<void>(resolve => { releaseSecond = resolve; });
    const first = await contextProvider([{ id: "m1", context_length: 128000 }], [{ toolCalls: [read], wait: firstWait }]);
    const second = await contextProvider([{ id: next.model, context_length: 64000 }], [{ text: "Analysis", usage: { prompt_tokens: 3200, completion_tokens: 20 }, wait: secondWait }]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-context-switch-")); fs.writeFileSync(path.join(dir, "note"), "observed");
    const db = openLatticeDb(path.join(dir, "data")); const tasks = new TaskManager(db.raw, dir);
    try {
      const { taskId } = tasks.createTask({ workspace: ".", objective: "Inspect", acceptance: ["response"], provider: "local", model: "m1", baseUrl: first.url });
      await tasks.refreshContext(taskId); tasks.startTask(taskId, "start"); await until(() => first.requests.length === 1);
      expect(tasks.selectModel(taskId, "select", next.provider, next.model, second.url).accepted).toBe(true);
      expect(tasks.snapshot(taskId).contextUsage).toMatchObject({ known: false, contextWindow: 128000, model: "m1" });
      releaseFirst(); await until(() => second.requests.length === 1); await tasks.refreshContext(taskId);
      const changed = tasks.snapshot(taskId).contextUsage;
      expect(changed).toMatchObject({ known: false, provider: next.provider, model: next.model, endpoint: second.url, contextWindow: 64000 });
      expect(changed.usedTokens).toBeUndefined();
      releaseSecond(); await until(() => tasks.snapshot(taskId).state !== "RUNNING");
      expect(tasks.snapshot(taskId).contextUsage).toMatchObject({ known: true, usedTokens: 3200, contextWindow: 64000, model: next.model, endpoint: second.url });
      expect(first.catalogReads).toBe(1); expect(second.catalogReads).toBe(1);
    } finally { releaseFirst(); releaseSecond(); await tasks.close(); db.close(); await first.close(); await second.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not replace a confirmed sample when the next call is cancelled", async () => {
    let release = () => {}; const wait = new Promise<void>(resolve => { release = resolve; });
    const provider = await contextProvider([{ id: "m", context_length: 128000 }], [{ toolCalls: [read] }, { text: "Not completed", wait }]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-context-cancel-")); fs.writeFileSync(path.join(dir, "note"), "observed");
    const db = openLatticeDb(path.join(dir, "data")); const tasks = new TaskManager(db.raw, dir);
    try {
      const { taskId } = tasks.createTask({ workspace: ".", objective: "Inspect", acceptance: ["response"], provider: "local", model: "m", baseUrl: provider.url });
      await tasks.refreshContext(taskId); tasks.startTask(taskId, "start"); await until(() => provider.requests.length === 2);
      const confirmed = tasks.snapshot(taskId).contextUsage;
      expect(confirmed).toMatchObject({ known: true, usedTokens: 1900 });
      tasks.stop(taskId, "human-stop"); await until(() => tasks.snapshot(taskId).state !== "RUNNING");
      expect(tasks.snapshot(taskId).state).toBe("CANCELLED"); expect(tasks.snapshot(taskId).contextUsage).toEqual(confirmed);
      expect(tasks.snapshot(taskId).budget.uncertainUsageAttempts).toBe(1);
    } finally { release(); await tasks.close(); db.close(); await provider.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
