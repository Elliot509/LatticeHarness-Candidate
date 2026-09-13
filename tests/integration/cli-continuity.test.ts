import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskCommand } from "../../src/cli/run.js";
import { exportCommand, resumeCommand, sessionsCommand, wakeCommand } from "../../src/cli/continuity.js";
import { parseExportFile } from "../../src/telemetry/export.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fresh(): { workspace: string; dataDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-cli-s3-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "note.txt"), "hello\n");
  return { workspace, dataDir: path.join(dir, "data") };
}

function copyFixture(workspace: string): void {
  const src = path.resolve("fixtures/bug-prices");
  const copy = (from: string, to: string): void => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(path.join(from, entry.name), path.join(to, entry.name));
      else fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    }
  };
  copy(src, workspace);
}

function script(contents: unknown, dir: string, name: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await run();
    return { code, out };
  } finally {
    process.stdout.write = original;
  }
}

describe("s3 cli continuity", () => {
  it("runs, lists the session, and refuses resume of a completed task", async () => {
    const { workspace, dataDir } = fresh();
    copyFixture(workspace);
    const nodeExe = process.execPath;
    const scriptPath = script(
      [
        { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
        { text: "Fixed and verified." },
      ],
      workspace,
      "phase.json",
    );
    const lines: string[] = [];
    const code = await runTaskCommand({
      workspace,
      dataDir,
      task: "Fix the bug",
      acceptance: ["project test suite passes"],
      providerName: "fake",
      model: "fake-model-1",
      fakeScriptPath: scriptPath,
      verifyExecutable: nodeExe,
      verifyArgs: ["--test", "test/test.js"],
      onOutput: (line) => lines.push(line),
    });
    // The fixture bug is real here (sum.js unfixed), so verification fails
    // and the loop cannot STOP; what matters is persistence, not success.
    expect([0, 2, 3]).toContain(code);
    const listed = await captureStdout(() => sessionsCommand({ workspace, dataDir, json: true }));
    expect(listed.code).toBe(0);
    const sessions = JSON.parse(listed.out) as Array<{ taskId: string; sessionId: string; state: string }>;
    expect(sessions).toHaveLength(1);
    const taskId = sessions[0]?.taskId ?? "";
    expect(taskId.startsWith("task-")).toBe(true);
    // Completed tasks refuse resume; anything else reports continuity.
    const resumed = await captureStdout(() => resumeCommand({ workspace, dataDir, taskId, json: false }));
    if (sessions[0]?.state === "COMPLETED" || sessions[0]?.state === "CANCELLED") {
      expect(resumed.code).toBe(1);
      expect(resumed.out).toContain("resume refused");
    } else {
      expect(resumed.code).toBe(0);
      expect(resumed.out).toContain("session:");
    }
  });

  it("pauses with ASK and continues through run --resume to a verified STOP", async () => {
    const { workspace, dataDir } = fresh();
    copyFixture(workspace);
    const nodeExe = process.execPath;
    const first = script([{ text: "starting the investigation" }], workspace, "ask.json");
    const lines: string[] = [];
    const askCode = await runTaskCommand({
      workspace,
      dataDir,
      task: "Fix the bug",
      acceptance: ["project test suite passes"],
      providerName: "fake",
      model: "fake-model-1",
      fakeScriptPath: first,
      onOutput: (line) => lines.push(line),
    });
    expect(askCode).toBe(2);
    const listed = await captureStdout(() => sessionsCommand({ workspace, dataDir, json: true }));
    const sessions = JSON.parse(listed.out) as Array<{ taskId: string; sessionId: string; state: string }>;
    expect(sessions[0]?.state).toBe("NEEDS_INPUT");
    const taskId = sessions[0]?.taskId ?? "";
    const sessionId = sessions[0]?.sessionId ?? "";

    const sumSource = fs.readFileSync(path.join(workspace, "src", "sum.js"), "utf8");
    const { createHash } = await import("node:crypto");
    const sumVersion = `sha256:${createHash("sha256").update(sumSource, "utf8").digest("hex").slice(0, 16)}`;
    const second = script(
      [
        { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
        {
          toolCalls: [
            {
              name: "edit",
              argumentsJson: JSON.stringify({
                kind: "replace",
                path: "src/sum.js",
                expectedVersion: sumVersion,
                oldText: "  return items.reduce((sum, item) => {\n    const line = item.price * item.qty;\n    const discount = item.price > 50 ? item.price * 0.1 : 0;\n    return sum + line - discount;\n  }, 0);",
                newText: "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  const discount = subtotal > 100 ? subtotal * 0.1 : 0;\n  return subtotal - discount;",
              }),
            },
          ],
        },
        { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
        { text: "Fixed and verified." },
      ],
      workspace,
      "finish.json",
    );
    const stopCode = await runTaskCommand({
      workspace,
      dataDir,
      task: "ignored on resume",
      acceptance: [],
      providerName: "fake",
      model: "fake-model-1",
      fakeScriptPath: second,
      verifyExecutable: nodeExe,
      verifyArgs: ["--test", "test/test.js"],
      resumeTaskId: taskId,
      onOutput: (line) => lines.push(line),
    });
    expect(stopCode).toBe(0);
    const relisted = await captureStdout(() => sessionsCommand({ workspace, dataDir, json: true }));
    const again = JSON.parse(relisted.out) as Array<{ taskId: string; sessionId: string; state: string }>;
    // Same session continued, terminal state observed, no duplicate session.
    expect(again).toHaveLength(1);
    expect(again[0]?.sessionId).toBe(sessionId);
    expect(again[0]?.state).toBe("COMPLETED");
  });

  it("refuses resume of unknown tasks and exports the session to an explicit file", async () => {
    const { workspace, dataDir } = fresh();
    const missing = await captureStdout(() => resumeCommand({ workspace, dataDir, taskId: "task-nope", json: false }));
    expect(missing.code).toBe(1);
    const first = script([{ text: "hello" }], workspace, "ask.json");
    await runTaskCommand({
      workspace,
      dataDir,
      task: "Small task",
      acceptance: ["done"],
      providerName: "fake",
      model: "fake-model-1",
      fakeScriptPath: first,
      onOutput: () => undefined,
    });
    const listed = await captureStdout(() => sessionsCommand({ workspace, dataDir, json: true }));
    const sessions = JSON.parse(listed.out) as Array<{ sessionId: string }>;
    const out = path.join(workspace, "out dir", "usage.jsonl");
    const exported = await captureStdout(() => exportCommand({ workspace, dataDir, sessionId: sessions[0]?.sessionId ?? "", out }));
    expect(exported.code).toBe(0);
    const parsed = parseExportFile(fs.readFileSync(out, "utf8"));
    expect(parsed.attempts.length).toBeGreaterThan(0);
    expect(parsed.complete.recordCount).toBe(parsed.attempts.length);
    const badSession = await captureStdout(() => exportCommand({ workspace, dataDir, sessionId: "session-nope", out }));
    expect(badSession.code).toBe(1);
  });

  it("delivers wakes with durable dedup", async () => {
    const { workspace, dataDir } = fresh();
    const first = script([{ text: "hello" }], workspace, "ask.json");
    await runTaskCommand({
      workspace,
      dataDir,
      task: "Waiting task",
      acceptance: ["done"],
      providerName: "fake",
      model: "fake-model-1",
      fakeScriptPath: first,
      onOutput: () => undefined,
    });
    const listed = await captureStdout(() => sessionsCommand({ workspace, dataDir, json: true }));
    const sessions = JSON.parse(listed.out) as Array<{ taskId: string }>;
    const taskId = sessions[0]?.taskId ?? "";
    const edge = await captureStdout(() =>
      wakeCommand({ workspace, dataDir, taskId, source: "input", cursor: "msg-1", observation: "human chose A", level: false }),
    );
    expect(edge.code).toBe(0);
    expect(edge.out).toContain("wake recorded");
    const levelOpts = { workspace, dataDir, taskId, source: "process:proc_1", cursor: "exit:0", observation: "done", level: true };
    const level1 = await captureStdout(() => wakeCommand(levelOpts));
    expect(level1.code).toBe(0);
    const level2 = await captureStdout(() => wakeCommand(levelOpts));
    expect(level2.code).toBe(0);
    expect(level2.out).toContain("duplicate wake ignored");
    const unknown = await captureStdout(() =>
      wakeCommand({ workspace, dataDir, taskId: "task-nope", source: "input", cursor: "m", observation: "hi", level: false }),
    );
    expect(unknown.code).toBe(1);
  });
});
