import { ExecTool, type ExecArgs } from "../tools/exec.js";
import type { ToolContext } from "../tools/types.js";

export interface VerifySpec {
  executable: string;
  argv: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface VerifyResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  timedOut: boolean;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  countsKnown: boolean;
  outputTail: string;
  durationMs: number;
}

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
}

// Minimal TAP-ish parser for `node --test` and similar runners:
// "ok N - name", "not ok N - name", "# skip". Anything else leaves the
// counts unknown rather than inventing them.
export function parseTapCounts(output: string): TestCounts | null {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let seen = false;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (/^not ok\b/.test(trimmed)) {
      failed += 1;
      seen = true;
    } else if (/^ok\b/.test(trimmed)) {
      passed += 1;
      seen = true;
      if (/#\s*skip\b/i.test(trimmed)) skipped += 1;
    }
  }
  return seen ? { passed, failed, skipped } : null;
}

// Spec reporter of `node --test` (the default): summary lines such as
// "ℹ pass 2", "ℹ fail 0", "ℹ skipped 0". Parsed only from whole lines to
// avoid inventing counts from log prose.
export function parseSpecCounts(output: string): TestCounts | null {
  let passed: number | null = null;
  let failed: number | null = null;
  let skipped = 0;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    const pass = /^ℹ\s+pass\s+(\d+)\s*$/.exec(trimmed);
    if (pass !== null && pass[1] !== undefined) passed = Number.parseInt(pass[1], 10);
    const fail = /^ℹ\s+fail\s+(\d+)\s*$/.exec(trimmed);
    if (fail !== null && fail[1] !== undefined) failed = Number.parseInt(fail[1], 10);
    const skip = /^ℹ\s+skipped\s+(\d+)\s*$/.exec(trimmed);
    if (skip !== null && skip[1] !== undefined) skipped = Number.parseInt(skip[1], 10);
  }
  if (passed === null || failed === null) return null;
  return { passed, failed, skipped };
}

export function parseVerifyCounts(output: string): TestCounts | null {
  return parseTapCounts(output) ?? parseSpecCounts(output);
}

export async function runVerify(
  spec: VerifySpec,
  context: ToolContext,
  exec: ExecTool = new ExecTool(),
): Promise<VerifyResult> {
  const startedAt = Date.now();
  const args: ExecArgs = {
    executable: spec.executable,
    argv: spec.argv,
    ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
  };
  const result = await exec.execute(args, context);
  return summarizeExecResult(
    `${spec.executable} ${spec.argv.join(" ")}`,
    context.workspaceRoot,
    result,
    Date.now() - startedAt,
  );
}

// Derives verification evidence from an already admitted, claimed and
// receipted exec result. The loop wrapper uses this so the verify command
// is never executed a second time outside the effect protocol.
export function summarizeExecResult(
  command: string,
  cwd: string,
  result: { status: string; summary: string; detail?: string },
  durationMs: number,
): VerifyResult {
  const detail = result.detail ?? "";
  const counts = parseVerifyCounts(detail);
  const exitMatch = /exit (-?\d+)/.exec(result.summary);
  return {
    command,
    cwd,
    exitCode: exitMatch !== null && exitMatch[1] !== undefined ? Number.parseInt(exitMatch[1], 10) : null,
    timedOut: result.status === "timeout",
    passed: counts?.passed ?? null,
    failed: counts?.failed ?? null,
    skipped: counts?.skipped ?? null,
    countsKnown: counts !== null,
    outputTail: detail.slice(-2000),
    durationMs,
  };
}

// Tracks the latest verification outcome so the loop can gate STOP on
// observed evidence instead of model text.
export class VerifyLedger {
  private latest: VerifyResult | null = null;

  record(result: VerifyResult): void {
    this.latest = result;
  }

  check(): { complete: boolean; reason: string } {
    if (this.latest === null) return { complete: false, reason: "no verification has run" };
    if (this.latest.timedOut || this.latest.exitCode === null) {
      return { complete: false, reason: `verification did not finish cleanly (${this.latest.command})` };
    }
    if (this.latest.exitCode !== 0 || (this.latest.failed ?? 1) > 0) {
      return {
        complete: false,
        reason: `verification failing: exit ${this.latest.exitCode}, failed=${this.latest.failed ?? "unknown"}`,
      };
    }
    if (!this.latest.countsKnown) {
      return {
        complete: false,
        reason: `verification exited 0 but test counts unknown; refusing to conclude from exit code alone`,
      };
    }
    return {
      complete: true,
      reason: `verified: ${this.latest.command} exit 0, passed=${this.latest.passed}, failed=0`,
    };
  }
}
