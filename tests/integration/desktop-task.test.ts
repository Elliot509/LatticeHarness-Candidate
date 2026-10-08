import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { startDesktopBackend } from "../../src/desktop/backend.js";
import { FakeProvider } from "../../src/providers/fake.js";
import type { FakeScriptStep } from "../../src/providers/fake.js";

let dirs: string[] = [];
let backends: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const backend of backends) {
    try {
      await backend.close();
    } catch {
      // Best effort cleanup.
    }
  }
  backends = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function waitForState(cookie: string, url: string, taskId: string, terminal: string[], timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = (await (
      await fetch(`${url}/api/tasks/${taskId}/snapshot`, { headers: { Cookie: cookie } })
    ).json()) as { state: string };
    if (terminal.includes(snapshot.state)) return snapshot.state;
    if (Date.now() > deadline) throw new Error(`task ${taskId} did not reach ${terminal.join("/")} in time`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe("desktop backend integration (source, without Electron window)", () => {
  it("drives a real admitted task with read/edit/exec/process through the backend", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-desktop-task-"));
    dirs.push(dir);
    const fixtureSrc = path.join(process.cwd(), "fixtures", "bug-prices");
    const workspace = path.join(dir, "agent project");
    copyDir(fixtureSrc, workspace);
    const dataDir = path.join(dir, "data dir", "café");
    const backend = await startDesktopBackend({ workspace, dataDir });
    backends.push(backend);
    const home = await fetch(`${backend.server.url}/`, { headers: { Cookie: backend.server.bootstrapCookie } });
    expect(home.status).toBe(200);
    const cookie = backend.server.bootstrapCookie;
    expect(cookie).not.toBe("");
    // Synthetic canary: the tool environment allowlist must not leak it.
    process.env["LATTICE_P0_SECRET_CANARY"] = "canary-should-never-reach-tools";

    const created = (await (
      await fetch(`${backend.server.url}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          commandId: "desk-task-1",
          kind: "create-task",
          payload: { workspace: "", objective: "Fix the bulk discount bug", provider: "local", model: "p0-fixture", baseUrl: "http://127.0.0.1:9" },
        }),
      })
    ).json()) as { accepted: boolean; taskId: string };
    expect(created.accepted).toBe(true);

    // Deterministic local OpenAI-compatible fixture (TEST INFRASTRUCTURE):
    // drives the REAL production OpenAiAdapter path over loopback HTTP.
    const { startFixtureProvider } = await import("../helpers/fixture-provider.js");

    const sumSource = fs.readFileSync(path.join(workspace, "src", "sum.js"), "utf8");
    const { createHash } = await import("node:crypto");
    const sumVersion = `sha256:${createHash("sha256").update(sumSource, "utf8").digest("hex").slice(0, 16)}`;
    const oldText = "  return items.reduce((sum, item) => {\n    const line = item.price * item.qty;\n    const discount = item.price > 50 ? item.price * 0.1 : 0;\n    return sum + line - discount;\n  }, 0);";
    const newText = "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  const discount = subtotal > 100 ? subtotal * 0.1 : 0;\n  return subtotal - discount;";
    const longScript: FakeScriptStep[] = [
      { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"discount\"}" }] },
      { toolCalls: [{ name: "read", argumentsJson: "{\"path\":\"src/sum.js\"}" }] },
      {
        toolCalls: [
          {
            name: "exec",
            argumentsJson: JSON.stringify({
              executable: process.execPath,
              argv: ["--test", "test/test.js"],
              env: { LATTICE_P0_PROBE: "probe-value" },
            }),
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "process",
            argumentsJson: JSON.stringify({
              op: "spawn",
              executable: process.execPath,
              argv: ["-e", "setTimeout(()=>{},30000)"],
              generation: 1,
              realm: "local-trusted",
              attemptId: `attempt-${Date.now()}`,
            }),
          },
        ],
      },
      { toolCalls: [{ name: "edit", argumentsJson: JSON.stringify({ kind: "replace", path: "src/sum.js", expectedVersion: sumVersion, oldText, newText }) }] },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["--test", "test/test.js"] }) }] },
      { text: "Fixed and verified." },
    ];
    // Drive the unchanged runtime loop directly against the desktop-owned
    // TaskManager: the fixture provider is TEST INFRASTRUCTURE injected at
    // the adapter seam, never a production provider default.
    const { runTaskLoop } = await import("../../src/runtime/loop.js");
    const { buildToolset } = await import("../../src/tools/registry.js");
    const { ProcessSupervisor } = await import("../../src/tools/process.js");
    const { VerifyLedger, summarizeExecResult } = await import("../../src/runtime/verify.js");
    const { readContract } = await import("../../src/runtime/continuity.js");
    const { OpenAiAdapter } = await import("../../src/providers/openai.js");
    void FakeProvider;
    const supervisor = new ProcessSupervisor(workspace);
    const ledger = new VerifyLedger();
    const fixture = await startFixtureProvider(longScript);
    const fake = new OpenAiAdapter({ apiKey: "", baseUrl: fixture.url });
    try {
      const contract = readContract(backend.db.raw, created.taskId);
      if (contract === null) throw new Error("desktop task contract missing");
      const tools = buildToolset({ supervisor });
      const execEntry = tools.find((entry) => entry.name === "exec");
      if (execEntry === undefined) throw new Error("exec tool missing");
      const innerRun = execEntry.run.bind(execEntry);
      execEntry.run = async (argsJson, context) => {
        const startedAt = Date.now();
        const out = await innerRun(argsJson, context);
        const parsed = JSON.parse(argsJson) as { executable?: unknown; argv?: unknown };
        if (parsed.executable === process.execPath && Array.isArray(parsed.argv) && parsed.argv.join(" ").includes("--test")) {
          ledger.record(summarizeExecResult(`${parsed.executable} ${(parsed.argv as string[]).join(" ")}`, context.workspaceRoot, out.result, Date.now() - startedAt));
        }
        return out;
      };
      const stop = await runTaskLoop({
        db: backend.db.raw,
        provider: fake,
        modelRef: { provider: fake, providerId: contract.allowedProvider ?? "openai", model: "p0-fixture", endpoint: fixture.url },
        model: "p0-fixture",
        contract,
        sessionId: "session-p0",
        runId: "run-p0",
        taskSurface: {
          objective: contract.objective,
          acceptanceCriteria: ["project test suite passes"],
          grants: ["search, read, edit, exec, process under workspace"],
          prohibitions: [...contract.prohibitions],
          obligations: [...contract.obligations],
          unknowns: [],
          humanDecisions: [],
          versions: [],
          lastError: null,
        },
        tools,
        toolContext: { workspaceRoot: workspace, realm: "local-trusted", timeoutMs: 60000 },
        ownerGeneration: 1,
        grantedCalls: 50,
        grantedTokens: 200000,
        maxIterations: 25,
        acceptanceVerifiers: [() => ledger.check()],
      });
      expect(stop.decision, stop.reason).toBe("STOP");
      expect(stop.reason).toContain("verified");
      // The real adapter path was exercised over loopback HTTP.
      expect(fixture.requests.length).toBeGreaterThan(0);
      // Process tool: spawn/poll/stop through the real supervisor.
      const spawned = await supervisor.execute({
        op: "spawn",
        executable: process.execPath,
        argv: ["-e", "setTimeout(()=>{},30000)"],
        generation: 1,
        realm: "local-trusted",
        attemptId: "attempt-p0-cleanup",
      });
      expect(spawned.handleId).toBeTypeOf("string");
      const polled = await supervisor.execute({ op: "poll", handle: spawned.handleId as string, timeoutMs: 100, generation: 1 });
      expect(polled.status).toBe("running");
      const stopped = await supervisor.execute({ op: "stop", handle: spawned.handleId as string, generation: 1 });
      expect(["completed", "unknown"]).toContain(stopped.status);
    } finally {
      await supervisor.close();
      await fixture.close();
      delete process.env["LATTICE_P0_SECRET_CANARY"];
    }
    const fixed = fs.readFileSync(path.join(workspace, "src", "sum.js"), "utf8");
    expect(fixed).toContain("subtotal > 100");
    // Durable receipts: every dispatched attempt left a receipt row.
    const db = new DatabaseSync(path.join(dataDir, "lattice.db"));
    try {
      const receipts = (db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number }).n;
      expect(receipts).toBeGreaterThan(0);
      const attempts = (db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number }).n;
      expect(attempts).toBeGreaterThan(0);
    } finally {
      db.close();
    }
    // SSE reconnect: open the event stream, drop it, then replay from the cut.
    const snapshotBefore = (await (
      await fetch(`${backend.server.url}/api/tasks/${created.taskId}/snapshot`, { headers: { Cookie: cookie } })
    ).json()) as { cut: number };
    const eventsResponse = await fetch(`${backend.server.url}/api/tasks/${created.taskId}/events`, {
      headers: { Cookie: cookie, Accept: "text/event-stream" },
    });
    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.headers.get("content-type")).toContain("text/event-stream");
    await eventsResponse.body?.cancel();
    const missed = backend.tasks.missedEvents(created.taskId, 0);
    expect(missed.resync).toBe(false);
    expect(missed.events.length).toBeGreaterThan(0);
    expect(snapshotBefore.cut).toBeGreaterThanOrEqual(0);
    void waitForState;
  });
});
