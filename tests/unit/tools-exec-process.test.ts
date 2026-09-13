import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ExecTool } from "../../src/tools/exec.js";
import { ProcessSupervisor } from "../../src/tools/process.js";
import { parseTapCounts, runVerify, VerifyLedger } from "../../src/runtime/verify.js";
import type { ToolContext } from "../../src/tools/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function context(): ToolContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-exec-"));
  dirs.push(root);
  return { workspaceRoot: root, realm: "local-trusted", timeoutMs: 10_000 };
}

const NODE = process.execPath;

describe("exec tool", () => {
  it("runs argv commands with explicit cwd and captures output", async () => {
    const ctx = context();
    const tool = new ExecTool();
    const result = await tool.execute({ executable: NODE, argv: ["-e", "console.log('hi')"] }, ctx);
    expect(result.status).toBe("completed");
    expect(result.detail).toContain("hi");
    expect(result.summary).toContain("exit 0");
  });

  it("reports non-zero exits without inventing success", async () => {
    const ctx = context();
    const tool = new ExecTool();
    const result = await tool.execute({ executable: NODE, argv: ["-e", "process.exit(3)"] }, ctx);
    expect(result.status).toBe("completed");
    expect(result.errorKind).toBe("non-zero-exit");
    expect(result.summary).toContain("exit 3");
  });

  it("times out, kills the tree and marks the effect uncertain", async () => {
    const ctx = context();
    const tool = new ExecTool();
    const result = await tool.execute(
      { executable: NODE, argv: ["-e", "setInterval(()=>{}, 1000)"], timeoutMs: 500 },
      ctx,
    );
    expect(result.status).toBe("timeout");
    expect(result.effectUncertain).toBe(true);
  });

  it("caps large stdout and declares truncation", async () => {
    const ctx = context();
    const tool = new ExecTool();
    const result = await tool.execute(
      { executable: NODE, argv: ["-e", "process.stdout.write('x'.repeat(100000))"], maxBytes: 1024 },
      ctx,
    );
    expect(result.truncated).toBe(true);
    expect(result.detail).toContain("truncated");
  });

  it("rejects spawn failures, escapes and bad timeouts", async () => {
    const ctx = context();
    const tool = new ExecTool();
    expect((await tool.execute({ executable: "lattice-no-such-binary-xyz" }, ctx)).errorKind).toBe("spawn-failed");
    expect((await tool.execute({ executable: NODE, cwd: ".." }, ctx)).errorKind).toBe("invalid-args");
    expect((await tool.execute({ executable: NODE, timeoutMs: -1 }, ctx)).errorKind).toBe("invalid-args");
  });
});

describe("process supervisor", () => {
  it("spawns, polls output and observes exit", async () => {
    const ctx = context();
    const supervisor = new ProcessSupervisor(ctx.workspaceRoot);
    try {
      const spawned = await supervisor.execute({
        op: "spawn", executable: NODE, argv: ["-e", "console.log('ready')"], generation: 1, realm: "local-trusted", attemptId: "a1",
      });
      expect(spawned.status).toBe("running");
      const handle = spawned.handleId ?? "";
      let saw = "";
      let done = false;
      for (let i = 0; i < 50 && !done; i += 1) {
        const polled = await supervisor.execute({ op: "poll", handle, timeoutMs: 200, generation: 1 });
        if (polled.detail !== undefined) saw += polled.detail;
        if (polled.status === "completed") done = true;
      }
      expect(done).toBe(true);
      expect(saw).toContain("ready");
    } finally {
      await supervisor.close();
    }
  });

  it("sends stdin only when opened and stops the tree", async () => {
    const ctx = context();
    const supervisor = new ProcessSupervisor(ctx.workspaceRoot);
    try {
      const spawned = await supervisor.execute({
        op: "spawn",
        executable: NODE,
        argv: ["-e", "process.stdin.on('data', (d) => { process.stdout.write('echo:' + d); process.exit(0); })"],
        stdinOpen: true,
        generation: 1,
        realm: "local-trusted",
        attemptId: "a1",
      });
      const handle = spawned.handleId ?? "";
      const sent = await supervisor.execute({ op: "send", handle, text: "hi\n", generation: 1 });
      expect(sent.status).toBe("running");
      let saw = false;
      for (let i = 0; i < 50 && !saw; i += 1) {
        const polled = await supervisor.execute({ op: "poll", handle, timeoutMs: 200, generation: 1 });
        if (polled.detail?.includes("echo:hi") === true) saw = true;
      }
      expect(saw).toBe(true);

      const looping = await supervisor.execute({
        op: "spawn", executable: NODE, argv: ["-e", "setInterval(()=>{}, 500)"], generation: 1, realm: "local-trusted", attemptId: "a2",
      });
      const loopHandle = looping.handleId ?? "";
      const stopped = await supervisor.execute({ op: "stop", handle: loopHandle, generation: 1 });
      expect(["completed", "unknown"]).toContain(stopped.status);
      expect(stopped.summary).toMatch(/stopped|did not exit/);
    } finally {
      await supervisor.close();
    }
  });

  it("rejects closed stdin, stale generations and unknown handles", async () => {
    const ctx = context();
    const supervisor = new ProcessSupervisor(ctx.workspaceRoot);
    try {
      const spawned = await supervisor.execute({
        op: "spawn", executable: NODE, argv: ["-e", "setInterval(()=>{}, 5000)"], generation: 1, realm: "local-trusted", attemptId: "a1",
      });
      const handle = spawned.handleId ?? "";
      expect((await supervisor.execute({ op: "send", handle, text: "x", generation: 1 })).errorKind).toBe("invalid-args");
      expect((await supervisor.execute({ op: "poll", handle, timeoutMs: 10, generation: 2 })).errorKind).toBe("invalid-args");
      expect((await supervisor.execute({ op: "poll", handle: "proc_missing", timeoutMs: 10, generation: 1 })).errorKind).toBe("invalid-args");
    } finally {
      await supervisor.close();
    }
  });

  it("observation timeout returns running without killing", async () => {
    const ctx = context();
    const supervisor = new ProcessSupervisor(ctx.workspaceRoot);
    try {
      const spawned = await supervisor.execute({
        op: "spawn", executable: NODE, argv: ["-e", "setInterval(()=>{}, 1000)"], generation: 1, realm: "local-trusted", attemptId: "a1",
      });
      const handle = spawned.handleId ?? "";
      const quick = await supervisor.execute({ op: "poll", handle, timeoutMs: 200, generation: 1 });
      expect(quick.status).toBe("running");
      expect(quick.summary).toContain("observation timeout");
      const again = await supervisor.execute({ op: "poll", handle, timeoutMs: 200, generation: 1 });
      expect(again.status).toBe("running");
      const stopped = await supervisor.execute({ op: "stop", handle, generation: 1 });
      expect(stopped.status).toBe("completed");
      expect(stopped.summary).toContain("stopped");
    } finally {
      await supervisor.close();
    }
  });
});

describe("verification", () => {
  it("parses TAP counts and refuses to invent them", () => {
    expect(parseTapCounts("ok 1 - a\nnot ok 2 - b\nok 3 - c # SKIP reason\n")).toEqual({ passed: 2, failed: 1, skipped: 1 });
    expect(parseTapCounts("some unstructured log")).toBeNull();
  });

  it("runs the verify command and gates completion on evidence", async () => {
    const ctx = context();
    const failing = await runVerify({ executable: NODE, argv: ["-e", "process.exit(1)"] }, ctx);
    expect(failing.exitCode).toBe(1);
    const ledger = new VerifyLedger();
    ledger.record(failing);
    expect(ledger.check().complete).toBe(false);

    const passing = await runVerify(
      { executable: NODE, argv: ["-e", "console.log('ok 1 - a')"] },
      ctx,
    );
    expect(passing.countsKnown).toBe(true);
    ledger.record(passing);
    expect(ledger.check()).toEqual({
      complete: true,
      reason: expect.stringContaining("passed=1"),
    });
  });

  it("exit zero with unknown counts does not conclude", () => {
    const ledger = new VerifyLedger();
    ledger.record({
      command: "x", cwd: "/w", exitCode: 0, timedOut: false,
      passed: null, failed: null, skipped: null, countsKnown: false,
      outputTail: "", durationMs: 1,
    });
    expect(ledger.check().complete).toBe(false);
  });
});
