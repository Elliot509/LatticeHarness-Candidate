import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { FakeProvider } from "../../src/providers/fake.js";

const literal = 'crie uma pasta chamada "aulas_ingles" dentro deste ambiente.';
const usage = { inputTokens: 20, outputTokens: 5, inclusiveInput: true };
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-creation-scope-"));
  const root = path.join(dir, "selected-project"); fs.mkdirSync(root);
  const db = openLatticeDb(path.join(dir, "data"));
  return { dir, root, db, tasks: new TaskManager(db.raw, root) };
}
async function settled(tasks: TaskManager, id: string) {
  const deadline = Date.now() + 5000;
  while (tasks.snapshot(id).state === "RUNNING") {
    if (Date.now() > deadline) throw new Error("creation deadline");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

describe("creation in the explicitly selected workspace", () => {
  it.each([
    [literal, "aulas_ingles", false],
    ["Crie uma pasta chamada aulas_ingles", "aulas_ingles", false],
    ['Crie uma pasta chamada "Python" dentro desse lugar.', "Python", false],
    [literal, "aulas_ingles", true],
    ['Crie uma pasta chamada "aulas-ingles" neste ambiente.', "aulas-ingles", false],
    ['Crie uma pasta chamada "Aulas de inglês" dentro desse ambiente.', "Aulas de inglês", false],
  ] as const)("verifies %s (preexisting=%s)", async (objective, target, preexisting) => {
    const f = fixture(); if (preexisting) fs.mkdirSync(path.join(f.root, target));
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [preexisting
        ? { name: "read", argumentsJson: '{"kind":"directory","path":"."}' }
        : { name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", `require('fs').mkdirSync(${JSON.stringify(target)})`] }) }], usage }]);
      expect(f.tasks.snapshot(taskId).contextUsage.known).toBe(false);
      expect(f.tasks.startTask(taskId, "start", provider).accepted).toBe(true);
      await settled(f.tasks, taskId);
      const result = f.tasks.snapshot(taskId);
      expect(result.workspace).toBe(f.root); expect(result.acceptanceCriteria).toEqual([`directory-exists:${target}`]);
      expect(result.state).toBe("COMPLETED"); expect(provider.requests).toHaveLength(1);
      expect(fs.statSync(path.join(f.root, target)).isDirectory()).toBe(true);
      expect(result.messages.filter(m => m.source === "verified")).toMatchObject([{ text: `A pasta "${target}" existe no projeto. Existência confirmada pelo Lattice.` }]);
    } finally { await f.tasks.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it("does not turn a zero-exit command into verified creation", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: literal, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "console.log('not created')"] }) }], usage }, { text: "Unable to create", usage }]);
      f.tasks.startTask(taskId, "start", provider); await settled(f.tasks, taskId);
      expect(fs.existsSync(path.join(f.root, "aulas_ingles"))).toBe(false);
      expect(f.tasks.snapshot(taskId).state).not.toBe("COMPLETED");
      expect(f.tasks.snapshot(taskId).messages.some(m => m.source === "verified")).toBe(false);
    } finally { await f.tasks.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  });

  it.each(['Crie uma pasta dentro deste ambiente.', 'Crie uma pasta chamada "../escape" dentro deste ambiente.'])("keeps ambiguous/escaping objectives blocked before inference: %s", async objective => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ text: "must not be requested", usage }]);
      expect(f.tasks.startTask(taskId, "start", provider)).toMatchObject({ accepted: true, state: "NEEDS_INPUT" });
      expect(provider.requests).toHaveLength(0); expect(f.tasks.snapshot(taskId).contextUsage.known).toBe(false);
      const before = f.tasks.snapshot(taskId);
      expect(f.tasks.steer(taskId, "guide", before.contractRevision, "continue", "guide")).toMatchObject({ accepted: true, state: "NEEDS_INPUT" });
      expect(f.tasks.snapshot(taskId).acceptanceCriteria).toEqual(["clarification-required"]);
      expect(f.tasks.snapshot(taskId).steering.at(-1)?.state).toBe("accepted");
      expect(provider.requests).toHaveLength(0);
    } finally { await f.tasks.close(); f.db.close(); fs.rmSync(f.dir, { recursive: true, force: true }); }
  });
});
