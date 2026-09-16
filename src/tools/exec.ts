import { spawn, type ChildProcess } from "node:child_process";
import { buildChildEnv, toolEnvOverlay } from "../platform/childEnv.js";
import type { ToolDefinition } from "../providers/types.js";
import { resolveInScope } from "../platform/paths.js";
import { toolFailure, type Tool, type ToolContext, type ToolResult } from "./types.js";

export type ExecArgs =
  | {
      mode?: "argv";
      executable: string;
      argv?: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      input?: string;
      maxBytes?: number;
    }
  | {
      mode: "shell";
      shell: "cmd" | "powershell" | "sh";
      command: string;
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      input?: string;
      maxBytes?: number;
    };

export const EXEC_DEFINITION: ToolDefinition = {
  name: "exec",
  description:
    "Run a project command with an explicit cwd and timeout. Fresh shell per command; no login shell; stdin closed unless input is provided. Reports terminal state or timeout with effect uncertainty.",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["argv", "shell"] },
      executable: { type: "string" },
      argv: { type: "array" },
      shell: { type: "string", enum: ["cmd", "powershell", "sh"] },
      command: { type: "string" },
      cwd: { type: "string" },
      env: { type: "object" },
      timeoutMs: { type: "number" },
      input: { type: "string" },
      maxBytes: { type: "number" },
    },
    additionalProperties: false,
  },
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BYTES = 256 * 1024;

function baseEnv(context: ToolContext, extra: Record<string, string> | undefined): Record<string, string> {
  return buildChildEnv(toolEnvOverlay(context, extra));
}

function resolveCommand(args: ExecArgs): { executable: string; argv: string[] } | { error: string } {
  if (args.mode === "shell") {
    if (typeof args.command !== "string" || args.command === "") {
      return { error: "shell mode requires a non-empty command" };
    }
    switch (args.shell) {
      case "cmd":
        return { executable: "cmd.exe", argv: ["/d", "/s", "/c", args.command] };
      case "powershell":
        return { executable: "powershell.exe", argv: ["-NoProfile", "-NonInteractive", "-Command", args.command] };
      case "sh":
        return { executable: "sh", argv: ["-c", args.command] };
      default:
        return { error: "shell must be cmd, powershell or sh" };
    }
  }
  if (typeof args.executable !== "string" || args.executable === "") {
    return { error: "argv mode requires an executable" };
  }
  if (args.argv !== undefined && (!Array.isArray(args.argv) || args.argv.some((a) => typeof a !== "string"))) {
    return { error: "argv must be an array of strings" };
  }
  return { executable: args.executable, argv: args.argv ?? [] };
}

async function killTree(child: ChildProcess, isClosed: () => boolean): Promise<void> {
  if (isClosed()) return;
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
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Process already gone; observation below confirms.
    }
  }
  const exited = await waitExit(child, isClosed, 2000);
  if (!exited) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process already gone; observation below confirms.
      }
    }
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

export class ExecTool implements Tool<ExecArgs> {
  readonly definition = EXEC_DEFINITION;

  async execute(rawArgs: ExecArgs, context: ToolContext): Promise<ToolResult> {
    const resolved = resolveCommand(rawArgs);
    if ("error" in resolved) {
      return toolFailure("invalid-args", resolved.error, false);
    }
    const timeoutMs = rawArgs.timeoutMs ?? context.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      return toolFailure("invalid-args", "timeoutMs must be a positive integer", false);
    }
    const maxBytes = rawArgs.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      return toolFailure("invalid-args", "maxBytes must be a positive integer", false);
    }
    const cwd = resolveInScope(context.workspaceRoot, rawArgs.cwd ?? ".");
    if (cwd === null) {
      return toolFailure("invalid-args", "exec cwd escapes the workspace", false);
    }
    if (rawArgs.env !== undefined) {
      const env: unknown = rawArgs.env;
      if (typeof env !== "object" || env === null || Object.values(env).some((v) => typeof v !== "string")) {
        return toolFailure("invalid-args", "env must map names to strings", false);
      }
    }

    const startedAt = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(resolved.executable, resolved.argv, {
        cwd,
        env: baseEnv(context, rawArgs.env),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch (error) {
      return toolFailure("spawn-failed", `cannot start process: ${error instanceof Error ? error.message : "unknown error"}`, false);
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const truncated = { stdout: false, stderr: false };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBytes < maxBytes) {
        const room = maxBytes - stdoutBytes;
        stdoutChunks.push(chunk.subarray(0, room));
        stdoutBytes += Math.min(chunk.length, room);
        if (chunk.length > room) truncated.stdout = true;
      } else {
        truncated.stdout = true;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBytes < maxBytes) {
        const room = maxBytes - stderrBytes;
        stderrChunks.push(chunk.subarray(0, room));
        stderrBytes += Math.min(chunk.length, room);
        if (chunk.length > room) truncated.stderr = true;
      } else {
        truncated.stderr = true;
      }
    });
    const spawnError = new Promise<string | null>((resolve) => {
      child.once("error", (error) => {
        resolve(error.message);
      });
      child.once("spawn", () => {
        resolve(null);
      });
    });
    // Completion means process exit AND stdio closed: 'exit' alone can fire
    // before buffered output is delivered ("close" is the drain signal).
    let closed = false;
    child.once("close", () => {
      closed = true;
    });
    const isClosed = (): boolean => closed;

    if (rawArgs.input !== undefined) {
      try {
        child.stdin?.write(rawArgs.input);
      } catch {
        // Closed or broken stdin surfaces in the exit observation below.
      }
    }
    try {
      child.stdin?.end();
    } catch {
      // Already closed; nothing to do.
    }

    const failed = await spawnError;
    if (failed !== null) {
      return toolFailure("spawn-failed", `cannot start process: ${failed}`, false);
    }

    const finished = await waitExit(child, isClosed, timeoutMs);
    const durationMs = Date.now() - startedAt;
    if (!finished) {
      await killTree(child, isClosed);
      await waitExit(child, isClosed, 5000);
      const end = endState(child);
      return {
        status: "timeout",
        summary: `command timed out after ${timeoutMs}ms (${end})`,
        detail: renderOutput(stdoutChunks, stderrChunks, truncated.stdout, truncated.stderr),
        truncated: truncated.stdout || truncated.stderr,
        effectUncertain: true,
      };
    }
    const code = child.exitCode;
    const out = renderOutput(stdoutChunks, stderrChunks, truncated.stdout, truncated.stderr);
    if (code === null) {
      return {
        status: "completed",
        summary: `terminated by signal ${child.signalCode ?? "unknown"} in ${durationMs}ms (cwd ${cwd})`,
        detail: out,
        truncated: truncated.stdout || truncated.stderr,
        errorKind: "non-zero-exit",
        errorRetryable: false,
      };
    }
    return {
      status: "completed",
      summary: `exit ${code} in ${durationMs}ms (cwd ${cwd})`,
      detail: out,
      truncated: truncated.stdout || truncated.stderr,
      ...(code !== 0 ? { errorKind: "non-zero-exit", errorRetryable: false } : {}),
    };
  }
}

function endState(child: ChildProcess): string {
  if (child.exitCode !== null) return `exit ${child.exitCode}`;
  return `signal ${child.signalCode ?? "unknown"}; process tree death unconfirmed`;
}

function renderOutput(stdout: Buffer[], stderr: Buffer[], outTrunc: boolean, errTrunc: boolean): string {
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");
  const parts = [`stdout:\n${out}`];
  if (outTrunc) parts.push("[stdout truncated]");
  parts.push(`stderr:\n${err}`);
  if (errTrunc) parts.push("[stderr truncated]");
  return parts.join("\n");
}
