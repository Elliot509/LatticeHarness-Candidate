import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// agentsview boundary: discovery plus controlled invocation. Every call runs
// with an explicit allowlist environment (never the whole process env, so a
// PLOW token in our environment can never reach the third-party binary) and
// enforces returncode, schema and timeout. A non-zero exit is always an
// error, even when stdout still parses.

export interface AgentsViewEnv {
  dataDir: string;
  exportsDir: string;
  tz?: string | undefined;
  // Additional provider source dirs (e.g. CLAUDE_PROJECTS_DIR) for tests
  // that prove attribution against a contaminated index. Production
  // reporting leaves this unset: only Lattice exports are indexed.
  extraEnv?: Record<string, string> | undefined;
}

export const STUB_CANARY_ENV = "STUB_CANARY_ONLY";

export class AgentsViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentsViewError";
  }
}

function childEnv(env: AgentsViewEnv): NodeJS.ProcessEnv {
  const allow = new Map<string, string>();
  const keep = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYSTEMROOT",
    "SystemRoot",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TZ",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
  ];
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) allow.set(key, value);
  }
  allow.set("AGENTSVIEW_DATA_DIR", env.dataDir);
  allow.set("LATTICE_EXPORTS_DIR", env.exportsDir);
  allow.set("TZ", env.tz ?? "UTC");
  // Test seam: the node-stub harness routes stub output on this marker. It
  // is set only by probeLatticeSupport below, never inherited or forwarded
  // from the ambient environment, so it cannot leak into real invocations.
  for (const [key, value] of Object.entries(env.extraEnv ?? {})) {
    if (/^[A-Z][A-Z0-9_]*(_DIR|_DIRS|_HOME|_PATH)$/.test(key) || key === STUB_CANARY_ENV) allow.set(key, value);
  }
  return Object.fromEntries(allow);
}

// Discovery order: explicit configuration first, then PATH (cross-platform,
// PATHEXT-aware on Windows), then the well-known install locations. Never
// shell out to `which`. A directory is NOT a binary: the node-stub tests
// pass process.execPath as the binary plus a stub dir as cwd, and a real
// directory here would resolve `sync` to nonsense instead of failing fast.
export function findAgentsView(explicitPath?: string): string | null {
  if (explicitPath !== undefined && explicitPath !== "") {
    try {
      if (fs.statSync(explicitPath).isFile()) return explicitPath;
    } catch {
      // Not a usable binary.
    }
    return null;
  }
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((dir) => dir !== "");
  const names = process.platform === "win32" ? ["agentsview.exe", "agentsview.cmd", "agentsview"] : ["agentsview"];
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate) && (process.platform === "win32" || (fs.statSync(candidate).mode & 0o111) !== 0)) {
          return candidate;
        }
      } catch {
        // Unreadable PATH entries are skipped, never fatal.
      }
    }
  }
  const home = os.homedir();
  for (const candidate of [
    path.join(home, ".local", "bin", process.platform === "win32" ? "agentsview.exe" : "agentsview"),
    "/opt/homebrew/bin/agentsview",
    "/usr/local/bin/agentsview",
  ]) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // Skip unreadable candidates.
    }
  }
  return null;
}

async function runAgentsView(
  binary: string,
  args: string[],
  env: AgentsViewEnv,
  timeoutMs: number,
  cwd?: string,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, args, {
      env: childEnv(env),
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      ...(cwd !== undefined ? { cwd } : {}),
    }));
  } catch (error) {
    if (!(error instanceof Error)) throw new AgentsViewError("agentsview spawn failed");
    const info = error as { code?: unknown; killed?: unknown };
    const details = info.code === "ETIMEDOUT" || info.killed === true ? `timed out after ${timeoutMs}ms` : error.message;
    const stderrValue = (error as { stderr?: unknown }).stderr;
    const tail = typeof stderrValue === "string" ? stderrValue.slice(-2000) : "";
    throw new AgentsViewError(`agentsview ${args[0] ?? ""} failed: ${details}${tail !== "" ? `; stderr tail: ${tail}` : ""}`);
  }
  return stdout;
}

export interface DailyModelRow {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface DailyRow {
  date: string;
  modelBreakdowns: DailyModelRow[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asCount(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AgentsViewError(`agentsview daily row has non-integer ${what}`);
  }
  return value;
}

// Refreshes the dedicated index, then returns the parsed daily rows.
// The caller decides the agent filter: Lattice reporting always passes
// "lattice" so other agents sharing anything can never leak in.
export async function queryDailyUsage(options: {
  binary: string;
  env: AgentsViewEnv;
  agent?: string | undefined;
  timeoutMs?: number | undefined;
  cwd?: string | undefined;
}): Promise<DailyRow[]> {
  const timeoutMs = options.timeoutMs ?? 60000;
  await runAgentsView(options.binary, ["sync"], options.env, Math.max(timeoutMs, 120000), options.cwd);
  const args = ["usage", "daily", "--json", "--offline"];
  if (options.agent !== undefined) args.push("--agent", options.agent);
  const stdout = await runAgentsView(options.binary, args, options.env, timeoutMs, options.cwd);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AgentsViewError("agentsview usage daily did not return JSON");
  }
  if (!isRecord(parsed)) throw new AgentsViewError("agentsview usage daily returned a non-object");
  const daily = parsed["daily"] ?? parsed["data"];
  if (!Array.isArray(daily)) throw new AgentsViewError("agentsview usage daily has no daily array");
  return daily.map((row, index) => {
    if (!isRecord(row) || typeof row["date"] !== "string" || !Array.isArray(row["modelBreakdowns"])) {
      throw new AgentsViewError(`agentsview daily row ${index} misses date or modelBreakdowns`);
    }
    return {
      date: row["date"],
      modelBreakdowns: row["modelBreakdowns"].map((entry: unknown, entryIndex: number) => {
        if (!isRecord(entry)) throw new AgentsViewError(`agentsview model breakdown ${index}.${entryIndex} is not an object`);
        const name = entry["modelName"] ?? entry["model"];
        if (typeof name !== "string" || name === "") {
          throw new AgentsViewError(`agentsview model breakdown ${index}.${entryIndex} has no model`);
        }
        return {
          modelName: name,
          inputTokens: asCount(entry["inputTokens"], "inputTokens"),
          outputTokens: asCount(entry["outputTokens"], "outputTokens"),
          // Missing partitions are incomplete data, never zero: refuse them
          // here rather than letting a quieter layer invent precision.
          cacheCreationTokens: asCount(entry["cacheCreationTokens"], "cacheCreationTokens"),
          cacheReadTokens: asCount(entry["cacheReadTokens"], "cacheReadTokens"),
        };
      }),
    };
  });
}

const CANARY_EXPORT = (session: string): string =>
  [
    JSON.stringify({
      schemaVersion: 1,
      recordType: "session",
      sessionId: session,
      rootId: "root-canary",
      createdAt: "2026-09-11T09:00:00Z",
      exportedAt: "2026-09-11T09:00:01Z",
      ledgerCut: 1,
      exportRevision: 1,
      producer: "Lattice",
      packageVersion: "0.0.0",
      usageCoverage: { attempts: 1, observed: 1, estimated: 0, unknown: 0, knownInputTotal: 7, knownOutputTotal: 3 },
      timezone: "UTC",
    }),
    JSON.stringify({
      recordType: "attempt_usage",
      canonicalDay: "2026-09-11",
      usage: {
        schemaVersion: 1,
        sessionId: session,
        runId: "run-canary",
        taskId: "task-canary",
        rootId: "root-canary",
        requestId: "req-canary",
        attemptId: "attempt-canary",
        parentAttemptId: null,
        intentId: "intent-canary",
        executorGeneration: 1,
        provider: "fake",
        modelRequested: "canary-model",
        modelResolved: "canary-model",
        adapterRevision: "fake-1",
        usageRevision: 1,
        usageFinal: true,
        purpose: "primary",
        status: "completed",
        admittedAt: "2026-09-11T09:00:00Z",
        dispatchedAt: "2026-09-11T09:00:00Z",
        firstTokenAt: null,
        finishedAt: "2026-09-11T09:00:01Z",
        recordedAt: "2026-09-11T09:00:02Z",
        clockQuality: "wall",
        durationMs: 1000,
        providerRequestId: null,
        error: null,
        inputTotal: { value: 7, quality: "observed", source: "canary" },
        inputNew: { value: 7, quality: "observed", source: "canary" },
        cacheRead: { value: 0, quality: "observed", source: "canary" },
        cacheWrite: { value: 0, quality: "observed", source: "canary" },
        outputTotal: { value: 3, quality: "observed", source: "canary" },
        reasoningSubset: null,
      },
    }),
    JSON.stringify({ recordType: "export_complete", sessionId: session, recordCount: 1, ledgerCut: 1 }),
  ].join("\n");

// Real capability probe: indexes a canary export in an isolated home and
// reads it back through the Lattice provider. Proves the binary at hand
// actually carries Lattice support, instead of trusting a version string.
export async function probeLatticeSupport(
  binary: string,
  timeoutMs = 120000,
  cwd?: string,
): Promise<{ supported: true } | { supported: false; reason: string }> {
  // Production uses a real binary as `binary` with no stub cwd. Tests use
  // Node-as-stub: binary=process.execPath plus cwd=stub dir, where
  // sync.js/usage.js implement the two invocations. A directory as binary
  // fails the probe instead of resolving nonsense.
  const looksLikeStubRun = cwd !== undefined;
  if (!looksLikeStubRun) {
    try {
      if (!fs.statSync(binary).isFile()) {
        return { supported: false, reason: `not an executable file: ${binary}` };
      }
    } catch {
      return { supported: false, reason: `cannot stat binary: ${binary}` };
    }
  }
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-av-probe-"));
  try {
    const exportsDir = path.join(sandbox, "exports");
    fs.mkdirSync(exportsDir, { recursive: true });
    fs.writeFileSync(path.join(exportsDir, "canary.jsonl"), `${CANARY_EXPORT("session-canary")}\n`);
    // The node-stub harness used by unit tests answers the probe from stub
    // scripts: route it to the canary document. Real binaries ignore this
    // variable (it is allowlisted nowhere else) and index the canary export.
    const env: AgentsViewEnv = {
      dataDir: path.join(sandbox, "avdata"),
      exportsDir,
      extraEnv: { [STUB_CANARY_ENV]: "1" },
    };
    const rows = await queryDailyUsage({ binary, env, agent: "lattice", timeoutMs, ...(cwd !== undefined ? { cwd } : {}) });
    const canary = rows.find((row) => row.date === "2026-09-11");
    const breakdown = canary?.modelBreakdowns.find((entry) => entry.modelName === "canary-model");
    if (breakdown?.inputTokens === 7 && breakdown.outputTokens === 3) return { supported: true };
    return { supported: false, reason: "canary export indexed but not visible under --agent lattice" };
  } catch (error) {
    return { supported: false, reason: error instanceof Error ? error.message : "unknown probe failure" };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
