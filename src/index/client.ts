import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Official Agent Index client boundary. The client script (pinned upstream
// revision, configured explicitly, never vendored) runs as a subprocess with
// an allowlist environment. This wrapper enforces what the integration
// contract requires: returncode discipline, status-code fidelity (0/3/2 are
// never collapsed), credential redaction in everything we record, and no
// registration side effects from read-only questions.

export type RegistrationState = "registered" | "unregistered" | "state-error" | "unknown";

export interface ClientConfig {
  python: string;
  script: string;
}

export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientError";
  }
}

// The Lattice filter marker: only a client carrying the AGENT_INDEX_AGENTS
// support may be used for Lattice reporting, otherwise other agents sharing
// the index could leak into the report with no error.
export function clientSupportsAgentFilter(scriptPath: string): boolean {
  let text: string;
  try {
    text = fs.readFileSync(scriptPath, "utf8");
  } catch {
    return false;
  }
  return text.includes("AGENT_INDEX_AGENTS");
}

export function findPython(explicitPath?: string): string | null {
  if (explicitPath !== undefined && explicitPath !== "") {
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }
  const pathDirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((dir) => dir !== "");
  const names = process.platform === "win32" ? ["python.exe", "python3.exe", "python"] : ["python3", "python"];
  for (const dir of pathDirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch {
        // Skip unreadable PATH entries.
      }
    }
  }
  return null;
}

function baseEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const allow = new Map<string, string>();
  // Explicit overrides win over inheritance: the caller controls identity,
  // filtering and endpoints per invocation, never the ambient process env.
  // HOME and USERPROFILE are always explicit in the runs below, so the
  // client state resolves under the caller's home even inside shared
  // test workers.
  for (const key of [
    "PATH",
    "HOME",
    "USERPROFILE",
    "USER",
    "LOGNAME",
    "SYSTEMROOT",
    "SystemRoot",
    "TMPDIR",
    "TEMP",
    "TMP",
    "TZ",
    "LANG",
    "LC_ALL",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "AGENTSVIEW_DATA_DIR",
    "AGENT_INDEX_AGENTS",
    "AGENT_INDEX_API",
    "AGENT_ID",
    "HERMES_HOME",
  ]) {
    const value = extra[key] ?? process.env[key];
    if (value !== undefined) allow.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!allow.has(key)) allow.set(key, value);
  }
  // The Lattice reporter never inherits a Hermes home: Hermes usage must not
  // merge into a Lattice report, and a stale HERMES_HOME pointing at nothing
  // would turn the Hermes collector into a hard failure. Hermes presence is
  // gated explicitly by the reporter instead.
  if (!("HERMES_HOME" in extra)) allow.delete("HERMES_HOME");
  return Object.fromEntries(allow);
}

const SECRET_PATTERN = /(aik_[A-Za-z0-9_-]{8,}|sk-(?:test|live|proj|ant|sv)-[A-Za-z0-9_-]{4,}|(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9]{20,}|Bearer\s+\S+|PLOW_AGENT_TOKEN\s*=\s*\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[bpas]-[A-Za-z0-9-]+)/g;

// Redaction for everything we record or print about client runs. The token
// travels only inside the client subprocess environment, never in our logs,
// state files, argv or errors.
export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, "[redacted]");
}

export interface ClientRun {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

async function runClient(
  config: ClientConfig,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
  cwd: string,
): Promise<ClientRun> {
  try {
    const { stdout, stderr } = await execFileAsync(config.python, [config.script, ...args], {
      env: baseEnv(env),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      cwd,
    });
    return { exitCode: 0, signal: null, stdout, stderr, timedOut: false };
  } catch (error) {
    const errno = error as { code?: unknown; killed?: unknown; status?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown };
    if (errno.code === "ETIMEDOUT" || errno.killed === true) {
      return {
        exitCode: null,
        signal: null,
        stdout: typeof errno.stdout === "string" ? errno.stdout : "",
        stderr: typeof errno.stderr === "string" ? errno.stderr : "",
        timedOut: true,
      };
    }
    const exitCode = typeof errno.code === "number" ? errno.code : typeof errno.status === "number" ? errno.status : 1;
    return {
      exitCode,
      signal: typeof errno.signal === "string" ? errno.signal : null,
      stdout: typeof errno.stdout === "string" ? errno.stdout : "",
      stderr: typeof errno.stderr === "string" ? errno.stderr : "",
      timedOut: false,
    };
  }
}

// Reads registration state only: no network, no purge, no agent id. Exit 0
// registered, 3 unregistered, 2 state unreadable; anything else is unknown
// and must never be treated as either.
export async function clientStatus(
  config: ClientConfig,
  home: string,
  timeoutMs = 60000,
): Promise<{ state: RegistrationState; exitCode: number | null; output: string }> {
  const run = await runClient(config, ["status"], { HOME: home, USERPROFILE: home }, timeoutMs, os.tmpdir());
  const output = redactSecrets(`${run.stdout}\n${run.stderr}`.trim());
  if (run.timedOut) return { state: "unknown", exitCode: null, output: `${output}\nstatus timed out` };
  if (run.exitCode === 0) return { state: "registered", exitCode: 0, output };
  if (run.exitCode === 3) return { state: "unregistered", exitCode: 3, output };
  if (run.exitCode === 2) return { state: "state-error", exitCode: 2, output };
  return { state: "unknown", exitCode: run.exitCode, output };
}

export interface CollectOptions {
  agent: string;
  days: number;
  dryRun: boolean;
  home: string;
  agentsviewDataDir: string;
  exportsDir: string;
  apiOverride?: string | undefined;
  credentialToken?: string | undefined;
  timeoutMs?: number | undefined;
}

// Collection/report run. The credential travels only in the subprocess
// environment of the official client; dry-run never publishes (but is not
// proof of payload — see the instrumented transport tests).
export async function clientCollect(config: ClientConfig, options: CollectOptions): Promise<ClientRun> {
  const args = ["--agent", options.agent, "--days", String(options.days)];
  if (options.dryRun) args.push("--dry-run");
  const env: Record<string, string> = {
    HOME: options.home,
    USERPROFILE: options.home,
    AGENTSVIEW_DATA_DIR: options.agentsviewDataDir,
    LATTICE_EXPORTS_DIR: options.exportsDir,
    AGENT_INDEX_AGENTS: "lattice",
    TZ: "UTC",
  };
  if (options.apiOverride !== undefined) env["AGENT_INDEX_API"] = options.apiOverride;
  if (options.credentialToken !== undefined) env["PLOW_AGENT_TOKEN"] = options.credentialToken;
  const run = await runClient(config, args, env, options.timeoutMs ?? 180000, os.tmpdir());
  return {
    ...run,
    stdout: redactSecrets(run.stdout),
    stderr: redactSecrets(run.stderr),
  };
}
