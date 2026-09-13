import fs from "node:fs";
import path from "node:path";
import { loadConfig, validateConfig } from "../config.js";
import { findAgentsView, probeLatticeSupport } from "../index/agentsview.js";
import { clientStatus, clientSupportsAgentFilter, findPython } from "../index/client.js";
import {
  backoffMs,
  loadReporterConfig,
  reporterPaths,
  reporterTick,
  saveReporterConfig,
  type IndexReporterConfig,
} from "../index/reporter.js";

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function resolveDataDir(workspace: string, dataDirInput: string | undefined): string {
  const config = loadConfig(
    { workspace: path.resolve(workspace), ...(dataDirInput !== undefined ? { dataDir: path.resolve(dataDirInput) } : {}) },
    process.cwd(),
  );
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) throw new Error(`Invalid configuration: ${configErrors.join("; ")}`);
  return config.dataDir;
}

export interface IndexStatusOptions {
  workspace: string;
  dataDir?: string | undefined;
  json: boolean;
}

// Status only reads: never registers, never reports, never writes secrets.
export async function indexStatusCommand(options: IndexStatusOptions): Promise<number> {
  let dataDir: string;
  try {
    dataDir = resolveDataDir(options.workspace, options.dataDir);
  } catch (error) {
    emit(`lattice: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
  const paths = reporterPaths(dataDir);
  const config = loadReporterConfig(paths);
  if (config === null) {
    const body = { configured: false, state: "unavailable", detail: "index not configured; run lattice index setup" };
    emit(options.json ? JSON.stringify(body, null, 2) : "index: unavailable (not configured; run lattice index setup)");
    return 0;
  }
  const agentsview = findAgentsView(config.agentsviewPath);
  const python = findPython(config.pythonPath);
  const clientOk = config.clientScript !== undefined && fs.existsSync(config.clientScript);
  let latticeSupport: string = agentsview === null ? "agentsview missing" : "unchecked";
  if (agentsview !== null) {
    const probe = await probeLatticeSupport(agentsview);
    latticeSupport = probe.supported ? "ok" : `missing (${probe.reason.slice(0, 120)})`;
  }
  const filterSupport = !clientOk ? "client missing" : clientSupportsAgentFilter(config.clientScript as string) ? "ok" : "missing";
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const registration =
    python !== null && clientOk && home !== ""
      ? await clientStatus({ python, script: config.clientScript as string }, home)
      : { state: "unknown" as const, exitCode: null as number | null, output: "client unavailable" };
  let stateInfo: { lastSuccessAt: string | null; pendingReason: string | null; consecutiveFailures: number } = {
    lastSuccessAt: null,
    pendingReason: null,
    consecutiveFailures: 0,
  };
  try {
    const state = JSON.parse(fs.readFileSync(paths.stateFile, "utf8")) as Partial<typeof stateInfo>;
    stateInfo = {
      lastSuccessAt: typeof state.lastSuccessAt === "string" ? state.lastSuccessAt : null,
      pendingReason: typeof state.pendingReason === "string" ? state.pendingReason : null,
      consecutiveFailures: typeof state.consecutiveFailures === "number" ? state.consecutiveFailures : 0,
    };
  } catch {
    // No state yet: fresh install.
  }
  const body = {
    configured: true,
    state: !config.enabled
      ? "disabled"
      : agentsview === null || !clientOk
        ? "unavailable"
        : "enabled",
    registered:
      registration.state === "registered"
        ? "registered"
        : registration.state === "unregistered"
          ? "unregistered"
          : registration.state === "state-error"
            ? "state-error"
            : "unknown",
    agentId: config.agentId,
    days: config.days,
    agentsview: agentsview ?? "not found",
    latticeSupport,
    clientFilter: filterSupport,
    coverage: "per export snapshot; incomplete windows refuse to publish",
    lastSuccessAt: stateInfo.lastSuccessAt,
    pendingReason: stateInfo.pendingReason,
    backoffMs: backoffMs(stateInfo.consecutiveFailures),
  };
  if (options.json) {
    emit(JSON.stringify(body, null, 2));
    return 0;
  }
  emit(`index: ${body.state}`);
  emit(`agent: ${config.agentId} (registered: ${body.registered})`);
  emit(`agentsview: ${body.agentsview} (lattice support: ${latticeSupport}; filter: ${filterSupport})`);
  emit(`last success: ${body.lastSuccessAt ?? "never"}${body.pendingReason !== null ? `; pending: ${body.pendingReason}` : ""}`);
  return 0;
}

export interface IndexSetupOptions {
  workspace: string;
  dataDir?: string | undefined;
  agentId: string;
  days?: number | undefined;
  agentsviewPath?: string | undefined;
  clientScript?: string | undefined;
  pythonPath?: string | undefined;
  credentialFile?: string | undefined;
  enable: boolean;
}

// Setup explains, validates and writes local configuration. It never mints,
// registers, publishes, or enables scheduling without explicit opt-in.
//
// S4.1-A extension (mechanical stages only): after the classic validation,
// the bootstrap state machine runs its non-consent stages (precheck, tool
// bootstrap with verified downloads, tool verification) and persists the
// setup state to AUTH_REQUIRED. Consent gates (mint/register/report/
// scheduler) stop with instructions — their effects belong to S4.1-B.
export async function indexSetupCommand(options: IndexSetupOptions): Promise<number> {
  let dataDir: string;
  try {
    dataDir = resolveDataDir(options.workspace, options.dataDir);
  } catch (error) {
    emit(`lattice: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
  emit("lattice index setup: reporting publishes per-day, per-model token counts and nothing else.");
  emit("No prompts, transcripts, paths, patches, costs or secrets ever leave the machine through this path.");
  const problems: string[] = [];
  const python = findPython(options.pythonPath);
  if (python === null) problems.push("python3 not found (pass --python)");
  const clientScript = options.clientScript;
  if (clientScript === undefined || !fs.existsSync(clientScript)) {
    problems.push("official client script not found (pass --client with the pinned agent_index_client.py)");
  } else if (!clientSupportsAgentFilter(clientScript)) {
    problems.push("official client without the Lattice agent filter; use the pinned revision carrying AGENT_INDEX_AGENTS support");
  }
  const agentsview = findAgentsView(options.agentsviewPath);
  if (agentsview === null) {
    problems.push("agentsview executable not found (pass --agentsview)");
  } else {
    emit("lattice: probing agentsview for Lattice provider support (canary export)...");
    const probe = await probeLatticeSupport(agentsview);
    if (!probe.supported) problems.push(`agentsview without Lattice support: ${probe.reason}`);
  }
  if (options.credentialFile !== undefined && !fs.existsSync(options.credentialFile)) {
    problems.push(`credential file not found: ${options.credentialFile}`);
  }
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  for (const dir of [path.join(home, ".hermes"), path.join(home, ".hermes-life")]) {
    try {
      if (home !== "" && fs.existsSync(path.join(dir, "state.db"))) {
        problems.push(`Hermes store present at ${dir}: Lattice reporting refuses to mix foreign usage on this machine`);
      }
    } catch {
      // Unreadable paths are not reported as Hermes presence.
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) emit(`lattice index setup: ${problem}`);
    emit("lattice index setup: configuration NOT written; fix the items above and rerun");
    return 1;
  }
  const config: IndexReporterConfig = {
    enabled: options.enable,
    agentId: options.agentId,
    days: options.days ?? 28,
    ...(agentsview !== null ? { agentsviewPath: agentsview } : {}),
    ...(clientScript !== undefined ? { clientScript } : {}),
    ...(python !== null ? { pythonPath: python } : {}),
    ...(options.credentialFile !== undefined ? { credentialFile: options.credentialFile } : {}),
  };
  saveReporterConfig(reporterPaths(dataDir), config);
  // S4.1-A bootstrap stages: verified tool downloads + persisted setup
  // state. Reuses the configured python; downloads come from the pinned
  // manifest over HTTPS with SHA256 verification (no clone/build/PATH).
  const { advanceSetup } = await import("../index/setup.js");
  const bootstrap = await advanceSetup(dataDir, { agentId: options.agentId });
  for (const step of bootstrap.steps) {
    emit(`lattice index setup: [${step.phase}] ${step.done ? "ok" : "PENDING"}: ${step.detail.slice(0, 200)}`);
  }
  emit(`lattice index setup: configuration written (${options.enable ? "reporting ENABLED" : "reporting disabled; rerun with --enable to opt in"})`);
  emit("Next official steps (run by you, never automatically):");
  emit(`  python3 <client> status                                  # expect exit 3 (not registered) on a fresh install`);
  emit(`  python3 <client> --register --agent ${options.agentId} --name Lattice --runtime Lattice   # real effect: needs a minted credential`);
  return 0;
}

export interface IndexDisableOptions {
  workspace: string;
  dataDir?: string | undefined;
}

// Disable stops future automatic reporting only. History, sessions,
// telemetry, the official install identity and the Plow account are
// preserved untouched: disable never revokes, deletes keys, or wipes state.
export function indexDisableCommand(options: IndexDisableOptions): Promise<number> {
  let dataDir: string;
  try {
    dataDir = resolveDataDir(options.workspace, options.dataDir);
  } catch (error) {
    emit(`lattice: ${error instanceof Error ? error.message : "unknown error"}`);
    return Promise.resolve(1);
  }
  const paths = reporterPaths(dataDir);
  const config = loadReporterConfig(paths);
  if (config === null) {
    emit("lattice index: not configured; nothing to disable");
    return Promise.resolve(0);
  }
  saveReporterConfig(paths, { ...config, enabled: false });
  emit("lattice index: automatic reporting disabled; history, sessions and official identity preserved");
  return Promise.resolve(0);
}

export async function indexTickCommand(workspace: string, dataDir: string | undefined, dryRun: boolean): Promise<number> {
  let resolved: string;
  try {
    resolved = resolveDataDir(workspace, dataDir);
  } catch (error) {
    emit(`lattice: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
  const result = await reporterTick(resolved, { dryRun });
  emit(`lattice index: ${result.status}: ${result.detail}`);
  return result.status === "reported" || result.status === "disabled" ? 0 : 1;
}
