import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "../providers/types.js";
import { resolveInScope } from "../platform/paths.js";
import { toolFailure, type ToolResult } from "./types.js";

export type ProcessOperation =
  | { op: "spawn"; executable: string; argv?: string[]; cwd?: string; env?: Record<string, string>; stdinOpen?: boolean; generation: number; realm: string; attemptId: string }
  | { op: "poll"; handle: string; timeoutMs?: number; generation: number }
  | { op: "send"; handle: string; text: string; generation: number }
  | { op: "stop"; handle: string; generation: number };

export const PROCESS_DEFINITION: ToolDefinition = {
  name: "process",
  description:
    "Supervise long-running processes by opaque handle: poll for new output, send to stdin when opened, stop the tree and observe. ACK of stop is not proof the tree died; unconfirmed death is reported as uncertain.",
  parameters: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["spawn", "poll", "send", "stop"] },
      executable: { type: "string" },
      argv: { type: "array" },
      cwd: { type: "string" },
      env: { type: "object" },
      stdinOpen: { type: "boolean" },
      handle: { type: "string" },
      text: { type: "string" },
      timeoutMs: { type: "number" },
      generation: { type: "number" },
      realm: { type: "string" },
      attemptId: { type: "string" },
    },
    required: ["op", "generation"],
    additionalProperties: false,
  },
};

const DEFAULT_MAX_BYTES = 256 * 1024;
const STOP_GRACE_MS = 3000;

interface Supervised {
  child: ChildProcess;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutCursor: number;
  stderrCursor: number;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  stdinOpen: boolean;
  generation: number;
  realm: string;
  attemptId: string;
  startedAt: string;
  exited: { code: number | null; signal: string | null } | null;
}

function renderNew(chunks: Buffer[], cursor: number): { text: string; cursor: number } {
  const full = Buffer.concat(chunks).toString("utf8");
  return { text: full.slice(cursor), cursor: full.length };
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function terminateTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    if (child.pid !== undefined) {
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        killer.on("error", () => {
          resolve();
        });
        killer.on("exit", () => {
          resolve();
        });
        setTimeout(resolve, 5000);
      });
    }
    return;
  }
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        return;
      }
    }
    const gone = await waitForExit(child, signal === "SIGTERM" ? STOP_GRACE_MS : 2000);
    if (gone) return;
  }
}

function waitExit(child: ChildProcess, isClosed: () => boolean, timeoutMs: number): Promise<boolean> {
  if (isClosed()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export class ProcessSupervisor {
  private readonly processes = new Map<string, Supervised>();
  private readonly maxBytes: number;
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string, maxBytes = DEFAULT_MAX_BYTES) {
    this.workspaceRoot = workspaceRoot;
    this.maxBytes = maxBytes;
  }

  async execute(rawArgs: ProcessOperation): Promise<ToolResult> {
    switch (rawArgs.op) {
      case "spawn":
        return Promise.resolve(this.spawn(rawArgs));
      case "poll":
        return this.poll(rawArgs.handle, rawArgs.timeoutMs ?? 1000, rawArgs.generation);
      case "send":
        return Promise.resolve(this.send(rawArgs.handle, rawArgs.text, rawArgs.generation));
      case "stop":
        return this.stop(rawArgs.handle, rawArgs.generation);
      default:
        return Promise.resolve(toolFailure("invalid-args", "unknown process op", false));
    }
  }

  private spawn(args: Extract<ProcessOperation, { op: "spawn" }>): ToolResult {
    if (typeof args.executable !== "string" || args.executable === "") {
      return toolFailure("invalid-args", "spawn requires an executable", false);
    }
    if (args.argv !== undefined && (!Array.isArray(args.argv) || args.argv.some((a) => typeof a !== "string"))) {
      return toolFailure("invalid-args", "argv must be an array of strings", false);
    }
    const cwd = resolveInScope(this.workspaceRoot, args.cwd ?? ".");
    if (cwd === null) {
      return toolFailure("invalid-args", "process cwd escapes the workspace", false);
    }
    let child: ChildProcess;
    try {
      child = spawn(args.executable, args.argv ?? [], {
        cwd,
        env: { ...process.env, ...(args.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      return toolFailure("spawn-failed", `cannot start process: ${error instanceof Error ? error.message : "unknown error"}`, false);
    }
    const record: Supervised = {
      child,
      stdout: [],
      stderr: [],
      stdoutCursor: 0,
      stderrCursor: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
      truncated: false,
      stdinOpen: args.stdinOpen === true,
      generation: args.generation,
      realm: args.realm,
      attemptId: args.attemptId,
      startedAt: new Date().toISOString(),
      exited: null,
    };
    const push = (store: Buffer[], chunk: Buffer): void => {
      if (record.stdoutBytes + record.stderrBytes >= this.maxBytes) {
        record.truncated = true;
        return;
      }
      store.push(chunk);
      if (store === record.stdout) record.stdoutBytes += chunk.length;
      else record.stderrBytes += chunk.length;
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      push(record.stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      push(record.stderr, chunk);
    });
    // Completion means process exit AND stdio closed: 'exit' alone can fire
    // before buffered output is delivered ("close" is the drain signal).
    child.once("close", (code, signal) => {
      record.exited = { code, signal: signal ?? null };
    });
    child.once("error", () => {
      record.exited = record.exited ?? { code: null, signal: "spawn-error" };
    });
    if (!record.stdinOpen) {
      try {
        child.stdin?.end();
      } catch {
        // Already closed; nothing to do.
      }
    }
    const handle = `proc_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    this.processes.set(handle, record);
    return {
      status: "running",
      summary: `process started (handle ${handle}, pid ${child.pid ?? "unknown"})`,
      handleId: handle,
      complete: false,
    };
  }

  private lookup(handle: string, generation: number): Supervised | ToolResult {
    const record = this.processes.get(handle);
    if (record === undefined) {
      return toolFailure("invalid-args", `unknown process handle; handles never transfer across generations`, false);
    }
    if (record.generation !== generation) {
      return toolFailure("invalid-args", "stale generation: handle belongs to another executor generation", false);
    }
    return record;
  }

  private async poll(handle: string, timeoutMs: number, generation: number): Promise<ToolResult> {
    const found = this.lookup(handle, generation);
    if (!("child" in found)) return found;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      return toolFailure("invalid-args", "timeoutMs must be a non-negative integer", false);
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const out = renderNew(found.stdout, found.stdoutCursor);
      const err = renderNew(found.stderr, found.stderrCursor);
      found.stdoutCursor = out.cursor;
      found.stderrCursor = err.cursor;
      if (found.exited !== null || out.text !== "" || err.text !== "") {
        return {
          status: found.exited !== null ? "completed" : "running",
          summary:
            found.exited !== null
              ? `process exited (code ${found.exited.code ?? "null"}, signal ${found.exited.signal ?? "none"})`
              : "process running",
          detail: `stdout:\n${out.text}\nstderr:\n${err.text}${found.truncated ? "\n[output truncated at supervisor cap]" : ""}`,
          truncated: found.truncated,
          complete: found.exited !== null,
        };
      }
      if (Date.now() >= deadline) {
        return {
          status: "running",
          summary: "observation timeout; process still running (this is not a process timeout)",
          complete: false,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private send(handle: string, text: string, generation: number): ToolResult {
    const found = this.lookup(handle, generation);
    if (!("child" in found)) return found;
    if (!found.stdinOpen) {
      return toolFailure("invalid-args", "stdin is closed for this process; it was not opened at spawn", false);
    }
    if (found.exited !== null) {
      return toolFailure("invalid-args", "process already exited; stdin is gone", false);
    }
    try {
      found.child.stdin?.write(text);
    } catch (error) {
      return toolFailure("io-error", `stdin write failed: ${error instanceof Error ? error.message : "unknown error"}`, true);
    }
    return { status: "running", summary: `sent ${text.length} chars to stdin`, complete: false };
  }

  private async stop(handle: string, generation: number): Promise<ToolResult> {
    const found = this.lookup(handle, generation);
    if (!("child" in found)) return found;
    if (found.exited !== null) {
      return {
        status: "completed",
        summary: `process already exited (code ${found.exited.code ?? "null"}, signal ${found.exited.signal ?? "none"})`,
        complete: true,
      };
    }
    await terminateTree(found.child);
    const reaped = await waitExit(found.child, () => found.exited !== null, 2000);
    if (reaped && found.child.exitCode !== null) {
      return {
        status: "completed",
        summary: `process stopped and reaped (exit ${found.child.exitCode})`,
        complete: true,
      };
    }
    if (reaped) {
      return {
        status: "completed",
        summary: `process stopped (signal ${found.child.signalCode ?? "unknown"}); descendant tree death unconfirmed`,
        complete: true,
        effectUncertain: true,
      };
    }
    return {
      status: "unknown",
      summary: "stop requested but the process did not exit within the grace period; tree death unconfirmed",
      complete: false,
      effectUncertain: true,
    };
  }

  async close(): Promise<void> {
    for (const [handle, record] of this.processes) {
      try {
        await terminateTree(record.child);
      } catch {
        // Best effort during shutdown.
      }
      this.processes.delete(handle);
    }
  }
}
