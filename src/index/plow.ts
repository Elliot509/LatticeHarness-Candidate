import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// plow-agents boundary: login, lines, mint through the OFFICIAL script only
// (pinned revision, stdlib-only, no Git/Docker/Compose dependency — proven
// by reading its imports: argparse/json/os/stat/sys/tempfile/time/urllib).
// The credential travels only in files and in the subprocess env of official
// tools, never in argv, logs, or the model context. Every effectful step
// runs only after explicit user consent collected by the setup flow.

export interface PlowConfig {
  python: string;
  script: string;
}

export class PlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlowError";
  }
}

export interface PlowLine {
  uid: string;
  name: string;
  free: boolean;
}

function plowEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const allow = new Map<string, string>();
  for (const key of [
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
    "PLOW_API_BASE",
  ]) {
    const value = extra[key] ?? process.env[key];
    if (value !== undefined) allow.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!allow.has(key)) allow.set(key, value);
  }
  return Object.fromEntries(allow);
}

async function runPlow(
  config: PlowConfig,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(config.python, [config.script, ...args], {
      env: plowEnv(env),
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      cwd: os.tmpdir(),
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const info = error as { code?: unknown; killed?: unknown; stdout?: unknown; stderr?: unknown; signal?: unknown };
    if (info.code === "ETIMEDOUT" || info.killed === true) {
      throw new PlowError(`plow-agents timed out after ${timeoutMs}ms`);
    }
    const code = typeof info.code === "number" ? info.code : 1;
    return {
      exitCode: code,
      stdout: typeof info.stdout === "string" ? info.stdout : "",
      stderr: typeof info.stderr === "string" ? info.stderr : "",
    };
  }
}

// Starts `login` and waits for the activation phrase the user texts from
// their phone. Returns the phrase to DISPLAY (never the credential); the
// caller polls `loginStatus` or simply reruns lines after the user confirms.
// In S4.1-A the flow is fully simulated by fakes; this wrapper only defines
// the argv/env contract the real script honors.
export function loginArgv(extra: string[] = []): string[] {
  return ["login", ...extra];
}

export async function plowLines(
  config: PlowConfig,
  timeoutMs = 60000,
): Promise<{ lines: PlowLine[] } | { error: string }> {
  const run = await runPlow(config, ["lines", "--json"], {}, timeoutMs);
  if (run.exitCode !== 0) {
    return { error: `plow-agents lines failed (exit ${run.exitCode}): ${run.stderr.slice(0, 300)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    return { error: "plow-agents lines did not return JSON" };
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as Record<string, unknown>)["data"];
  if (!Array.isArray(rows)) return { error: "plow-agents lines has no line list" };
  const lines: PlowLine[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record["uid"] !== "string") continue;
    lines.push({
      uid: record["uid"],
      name: typeof record["name"] === "string" ? record["name"] : record["uid"],
      free: record["agent_uid"] === null || record["agent_uid"] === undefined || record["agent_uid"] === "",
    });
  }
  return { lines };
}

// Mint writes the credential file ITSELF (the official script owns
// write_private semantics); the Lattice side only passes --credential-file
// pointing inside our private credentials dir, after explicit user consent
// for the chosen free line. Never pre-create the destination: mint refuses
// when it exists, which is the ownership signal.
export async function plowMint(
  config: PlowConfig,
  lineUid: string,
  credentialFile: string,
  timeoutMs = 900000,
): Promise<{ ok: true } | { error: string }> {
  const run = await runPlow(config, ["mint", lineUid, "--credential-file", credentialFile], {}, timeoutMs);
  if (run.exitCode !== 0) {
    return { error: `plow-agents mint failed (exit ${run.exitCode}): ${run.stderr.slice(0, 500)}` };
  }
  return { ok: true };
}

export function plowProvenanceNote(): string {
  return "plow-agents login/lines/mint are Python-stdlib + HTTPS only (no Git/Docker/Compose); verified by import scan of the pinned script.";
}
