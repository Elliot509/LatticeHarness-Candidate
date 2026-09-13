import fs from "node:fs";
import path from "node:path";
import { bootstrapDirs, writePinsManifest } from "./pins.js";
import { downloadVerified, resolvePython } from "./tools.js";
import { TOOL_PINS } from "./pins.js";
import { credentialDir } from "./credentials.js";

// Setup state machine for `lattice index setup`: resumable, observable,
// conservative, cross-platform. Material effects (mint, register, report,
// scheduler install) NEVER happen here — this machine only reaches their
// *_REQUIRED gates in S4.1-A and stops with instructions. Each phase checks
// its artifact first, so rerun after interruption resumes instead of
// redoing (and never duplicates) work.

export type SetupPhase =
  | "PRECHECK"
  | "TOOL_BOOTSTRAP"
  | "TOOL_VERIFICATION"
  | "AUTH_REQUIRED"
  | "ACTIVATION_PENDING"
  | "AUTHENTICATED"
  | "LINE_SELECTION_REQUIRED"
  | "MINT_CONFIRMATION_REQUIRED"
  | "CREDENTIAL_READY"
  | "REGISTRATION_REQUIRED"
  | "REGISTERED"
  | "ATTRIBUTION_VALIDATION"
  | "REPORT_CONSENT_REQUIRED"
  | "REPORTING_READY"
  | "SCHEDULER_CONSENT_REQUIRED"
  | "HEALTHY";

export interface SetupState {
  schemaVersion: 1;
  phase: SetupPhase;
  agentId: string | null;
  python: string | null;
  tools: Record<string, { revision: string; sha256: string; path: string }>;
  credentialFile: string | null;
  registered: boolean;
  reportConsented: boolean;
  schedulerConsented: boolean;
  updatedAt: string;
}

export function setupStatePath(dataDir: string): string {
  return path.join(bootstrapDirs(dataDir).state, "setup.json");
}

export function loadSetupState(dataDir: string): SetupState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(setupStatePath(dataDir), "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record["schemaVersion"] !== 1 || typeof record["phase"] !== "string") return null;
  return parsed as SetupState;
}

function saveSetupState(dataDir: string, state: SetupState): void {
  const dirs = bootstrapDirs(dataDir);
  fs.mkdirSync(dirs.state, { recursive: true });
  const tmp = path.join(dirs.state, `.setup.${process.pid}.new`);
  fs.writeFileSync(tmp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, setupStatePath(dataDir));
}

export function freshSetupState(agentId: string | null): SetupState {
  return {
    schemaVersion: 1,
    phase: "PRECHECK",
    agentId,
    python: null,
    tools: {},
    credentialFile: null,
    registered: false,
    reportConsented: false,
    schedulerConsented: false,
    updatedAt: new Date().toISOString(),
  };
}

export interface SetupDeps {
  fetch?: ((url: string) => Promise<Buffer>) | undefined;
  python?: string | undefined;
}

export interface SetupStep {
  phase: SetupPhase;
  done: boolean;
  detail: string;
}

// Advances the machine as far as mechanics allow without human consent:
// PRECHECK (platform/python) → TOOL_BOOTSTRAP (verified downloads) →
// TOOL_VERIFICATION (hashes + marker checks) → AUTH_REQUIRED (stop: needs
// `login` + activation text by the human). Later gates are represented but
// stop in S4.1-A — their effects belong to S4.1-B.
export async function advanceSetup(
  dataDir: string,
  options: { agentId?: string | undefined; deps?: SetupDeps | undefined } = {},
): Promise<{ state: SetupState; steps: SetupStep[] }> {
  const dirs = bootstrapDirs(dataDir);
  const previous = loadSetupState(dataDir);
  const state = previous ?? freshSetupState(options.agentId ?? null);
  if (options.agentId !== undefined && options.agentId !== "") state.agentId = options.agentId;
  const steps: SetupStep[] = [];

  // PRECHECK: platform + python detection (informational, never fatal to core).
  const platform = `${process.platform}-${process.arch}`;
  const supported = (process.platform === "linux" || process.platform === "win32") && process.arch === "x64";
  steps.push({
    phase: "PRECHECK",
    done: true,
    detail: supported
      ? `platform ${platform} supported`
      : `platform ${platform} not in S4.1 scope (linux/windows x64); continuing best-effort`,
  });
  const resolved = await resolvePython(options.deps?.python);
  if ("python" in resolved) {
    state.python = resolved.python;
    steps.push({ phase: "PRECHECK", done: true, detail: `python ${resolved.python}` });
  } else {
    steps.push({ phase: "PRECHECK", done: false, detail: resolved.error });
    state.phase = "PRECHECK";
    saveSetupState(dataDir, state);
    return { state, steps };
  }

  // TOOL_BOOTSTRAP: verified downloads into the private tools dir.
  writePinsManifest(dirs.manifests);
  let toolsOk = true;
  for (const pin of TOOL_PINS) {
    const dest = path.join(dirs.tools, pin.name, pin.artifactPath.split("/").pop() ?? pin.name);
    try {
      const result = await downloadVerified({
        repo: pin.repo,
        revision: pin.revision,
        artifactPath: pin.artifactPath,
        sha256: pin.sha256,
        destPath: dest,
        fetch: options.deps?.fetch,
      });
      state.tools[pin.name] = { revision: pin.revision, sha256: pin.sha256, path: dest };
      steps.push({
        phase: "TOOL_BOOTSTRAP",
        done: true,
        detail: `${pin.name}@${pin.revision.slice(0, 12)} ${result.downloaded ? "downloaded+verified" : "already present, hash ok"}`,
      });
    } catch (error) {
      toolsOk = false;
      steps.push({
        phase: "TOOL_BOOTSTRAP",
        done: false,
        detail: `${pin.name}: ${error instanceof Error ? error.message : "download failed"}`,
      });
    }
  }
  if (!toolsOk) {
    state.phase = "TOOL_BOOTSTRAP";
    saveSetupState(dataDir, state);
    return { state, steps };
  }

  // TOOL_VERIFICATION: pinned scripts are hash-verified by the download
  // itself; agentsview presence is probed at report time by the existing
  // canary check. No extra verification to invent here.
  steps.push({ phase: "TOOL_VERIFICATION", done: true, detail: "pinned scripts hash-verified; agentsview probed at report time" });

  // Credential dir exists (empty is fine — mint needs consent later).
  fs.mkdirSync(credentialDir(dataDir), { recursive: true, mode: 0o700 });
  state.phase = "AUTH_REQUIRED";
  steps.push({
    phase: "AUTH_REQUIRED",
    done: false,
    detail: "mechanical setup complete; next: human runs login + texts the activation phrase (S4.1-B performs mint/register/report)",
  });
  saveSetupState(dataDir, state);
  return { state, steps };
}
