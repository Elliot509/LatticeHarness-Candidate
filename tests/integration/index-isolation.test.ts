import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTaskCommand } from "../../src/cli/run.js";

// Core isolation: every external-integration failure mode must leave normal
// task execution untouched. The ranking stack is OPTIONAL; these tests break
// each of its pieces in turn and prove a fake-provider task still completes.

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fresh(): { workspace: string; dataDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-isolation-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  return { workspace, dataDir: path.join(dir, "data") };
}

async function runSmallTask(extraEnv: Record<string, string | undefined> = {}): Promise<number> {
  const { workspace, dataDir } = fresh();
  const script = path.join(workspace, "steps.json");
  fs.writeFileSync(script, JSON.stringify([{ text: "done" }]));
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(extraEnv)) {
    saved.set(key, process.env[key]);
    const value = extraEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
  try {
    const lines: string[] = [];
    return await runTaskCommand({
      workspace,
      dataDir,
      task: "Isolated task",
      acceptance: ["done"],
      providerName: "fake",
      model: "fake-model-1",
      fakeScriptPath: script,
      onOutput: (line) => lines.push(line),
    }).catch(() => 99);
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

describe("core isolation from the ranking stack", () => {
  it("runs without python on PATH", async () => {
    const code = await runSmallTask({ PATH: "" });
    expect([0, 2, 3]).toContain(code);
  });

  it("runs with broken agentsview/client/plow configuration present", async () => {
    const code = await runSmallTask({
      LATTICE_EXPORTS_DIR: "/nonexistent-exports",
      AGENTSVIEW_DATA_DIR: "/nonexistent-avdata",
      AGENT_INDEX_AGENTS: "lattice",
      HERMES_HOME: "/nonexistent-hermes",
    });
    expect([0, 2, 3]).toContain(code);
  });

  it("runs with a corrupt index state directory", async () => {
    const { workspace, dataDir } = fresh();
    const indexDir = path.join(dataDir, "index");
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, "config.json"), "{corrupt");
    fs.writeFileSync(path.join(indexDir, "state.json"), "{corrupt");
    const script = path.join(workspace, "steps.json");
    fs.writeFileSync(script, JSON.stringify([{ text: "done" }]));
    const lines: string[] = [];
    const code = await runTaskCommand({
      workspace,
      dataDir,
      task: "Isolated task",
      acceptance: ["done"],
      providerName: "fake",
      model: "fake-model-1",
      fakeScriptPath: script,
      onOutput: (line) => lines.push(line),
    });
    expect([0, 2, 3]).toContain(code);
  });
});
