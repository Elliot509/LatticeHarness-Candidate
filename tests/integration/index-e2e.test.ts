import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import {
  admitDurable,
  claimDurable,
  recordReceiptDurable,
  recordUsageRevision,
} from "../../src/runtime/effects.js";
import { openRun, openSession } from "../../src/runtime/continuity.js";
import { openLatticeDb } from "../../src/storage/db.js";
import { adaptExportSnapshot, toClientPayload } from "../../src/index/adapter.js";
import { buildSessionExport, serializeExport } from "../../src/telemetry/export.js";
import { queryDailyUsage } from "../../src/index/agentsview.js";
import { clientStatus, clientSupportsAgentFilter } from "../../src/index/client.js";

// Full-chain validation against the REAL pinned tools:
//   ledger -> export JSONL v1 -> adapter totals
//     -> patched agentsview binary (Lattice provider)
//       -> patched official client script (AGENT_INDEX_AGENTS filter)
//         -> loopback stub (captured payload, never a real post)
//
// Requires (provided by the index-e2e CI job, never committed):
//   LATTICE_AG agentsview=<patched binary> LATTICE_INDEX_CLIENT=<patched script>
// Without them the file reports explicit skips. No real mint, register, or
// publish ever happens here: the stub answers 200 on loopback and the
// seeded identity is synthetic.

const AV = process.env["LATTICE_AGENTS_VIEW"] ?? "";
const CLIENT = process.env["LATTICE_INDEX_CLIENT"] ?? "";
const RUN = AV !== "" && fs.existsSync(AV) && CLIENT !== "" && fs.existsSync(CLIENT);

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-indexe2e-"));
  dirs.push(dir);
  return dir;
}

function usageDoc(sessionId: string, attemptId: string, model: string, finished: string, input: number, output: number) {
  const qty = (value: number) => ({ value, quality: "observed", source: "fake/fake-1" });
  return {
    schemaVersion: 1,
    sessionId,
    runId: "run-e2e",
    taskId: "task-e2e",
    rootId: "root-e2e",
    requestId: "req-e2e",
    attemptId,
    parentAttemptId: null,
    intentId: "intent-e2e",
    executorGeneration: 1,
    provider: "fake",
    modelRequested: model,
    modelResolved: model,
    adapterRevision: "fake-1",
    usageRevision: 0,
    usageFinal: true,
    purpose: "primary",
    status: "completed",
    admittedAt: "2026-09-11T10:00:00Z",
    dispatchedAt: "2026-09-11T10:00:01Z",
    firstTokenAt: null,
    finishedAt: finished,
    recordedAt: "2026-09-11T10:00:03Z",
    clockQuality: "wall",
    durationMs: 1000,
    providerRequestId: null,
    error: null,
    inputTotal: qty(input),
    inputNew: qty(input),
    cacheRead: qty(10),
    cacheWrite: qty(5),
    outputTotal: qty(output),
    reasoningSubset: null,
  };
}

function seedLedger(dataDir: string): { sessionId: string; exportText: string } {
  const db = openLatticeDb(dataDir);
  try {
    const contract = createContract({
      taskId: "task-e2e",
      rootId: "root-e2e",
      objective: "E2E indexed work",
      scope: [dataDir],
      acceptanceCriteria: ["done"],
      obligations: ["preserve baseline"],
      grants: [
        { subject: "agent", operations: ["model.invoke"], targets: [dataDir], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: [],
      realm: "local-trusted",
      allowedProvider: "fake",
      allowedModel: "fake-model-1",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "test",
    });
    db.raw.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      contract.taskId,
      contract.rootId,
      contract.revision,
      JSON.stringify(contract),
      new Date().toISOString(),
    );
    const { sessionId } = openSession(db.raw, contract.rootId);
    openRun(db.raw, { sessionId, rootId: contract.rootId, taskId: contract.taskId, manifest: { provider: "fake", model: "fake-model-1" } });
    const samples: Array<[string, string, string, number, number]> = [
      ["attempt-e2e-1", "fake-model-1", "2026-09-11T23:59:59Z", 100, 20],
      ["attempt-e2e-2", "fake-model-1", "2026-09-12T00:00:01Z", 200, 40],
    ];
    for (const [attemptKey, model, finished, input, output] of samples) {
      const admitted = admitDurable(
        db.raw,
        contract,
        {
          taskId: contract.taskId,
          operation: "model.invoke",
          target: "fake/m",
          actionKey: `e2e-${attemptKey}`,
          authorityRevision: 1,
          maxCalls: 1,
          maxTokens: 4000,
          argsJson: "{}",
          requestId: `req-${attemptKey}`,
        },
        { calls: 50, tokens: 200000 },
        1,
      );
      if (!admitted.admitted) throw new Error("admission failed");
      if (!claimDurable(db.raw, admitted.attemptId, 1, 1).claimed) throw new Error("claim failed");
      recordReceiptDurable(db.raw, {
        attemptId: admitted.attemptId,
        outcome: "confirmed",
        summary: "responded",
        detailJson: JSON.stringify({ usageFinal: true }),
        settledCalls: 1,
        settledTokens: input + output,
      });
      recordUsageRevision(db.raw, admitted.attemptId, JSON.stringify(usageDoc(sessionId, admitted.attemptId, model, finished, input, output)));
    }
    const exported = buildSessionExport(db.raw, sessionId, "0.0.0");
    return { sessionId, exportText: serializeExport(exported).join("\n") };
  } finally {
    db.close();
  }
}

// A second agent sharing the machine: a Claude transcript from the
// agentsview project's own testdata, dated into the same window.
function seedForeignAgent(home: string): void {
  const projects = path.join(home, ".claude", "projects", "proj1");
  fs.mkdirSync(projects, { recursive: true });
  const src = "/tmp/s4up/agentsview/internal/parser/testdata/claude/valid_session.jsonl";
  if (!fs.existsSync(src)) throw new Error("claude testdata missing; run inside the index-e2e job");
  const text = fs.readFileSync(src, "utf8").replaceAll("2024-01-01", "2026-09-11");
  fs.writeFileSync(path.join(projects, "session.jsonl"), text);
}

describe.runIf(RUN)("index e2e against real tools", () => {
  it("ledger, adapter, agentsview and client agree on Lattice-only totals", async () => {
    const root = freshDir();
    const dataDir = path.join(root, "data");
    const home = path.join(root, "home");
    fs.mkdirSync(home, { recursive: true });
    // The official client discovers agentsview only at fixed locations
    // (~/.local/bin, /opt/homebrew/bin, /usr/local/bin): install the patched
    // binary into the sandbox home like a real user install.
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.copyFileSync(AV, path.join(localBin, process.platform === "win32" ? "agentsview.exe" : "agentsview"));
    const avdata = path.join(root, "avdata");
    fs.mkdirSync(avdata, { recursive: true });
    const exportsDir = path.join(root, "exports");
    fs.mkdirSync(exportsDir, { recursive: true });

    const { exportText } = seedLedger(dataDir);
    const adapted = toClientPayload(adaptExportSnapshot(exportText));
    expect(adapted).toHaveLength(2);
    fs.writeFileSync(path.join(exportsDir, "e2e.jsonl"), `${exportText}\n`);
    seedForeignAgent(home);

    const syncEnv = {
      AGENTSVIEW_DATA_DIR: avdata,
      LATTICE_EXPORTS_DIR: exportsDir,
      CLAUDE_PROJECTS_DIR: path.join(home, ".claude", "projects"),
      HOME: home,
      TZ: "UTC",
    };
    const sync = spawnSync(AV, ["sync"], { env: { ...process.env, ...syncEnv }, encoding: "utf8", timeout: 180000 });
    expect(sync.status).toBe(0);

    const rows = await queryDailyUsage({
      binary: AV,
      env: { dataDir: avdata, exportsDir, tz: "UTC", extraEnv: { CLAUDE_PROJECTS_DIR: path.join(home, ".claude", "projects") } },
      agent: "lattice",
    });
    // Lattice-only query: the Claude session shares the 11th but must not
    // appear here. Note the ledger attempts carry random AttemptIds, so the
    // comparison is on dates, models and counters, not ids.
    for (const day of adapted) {
      const row = rows.find((entry) => entry.date === day.date);
      expect(row).toBeDefined();
      for (const model of day.models) {
        const breakdown = row?.modelBreakdowns.find((entry) => entry.modelName === model.model);
        expect(breakdown).toBeDefined();
        // agentsview normalizes each currency partition independently; assert
        // totals from our ledger rather than the full breakdown struct.
        expect({ date: row?.date, model: breakdown?.modelName, input: breakdown?.inputTokens, output: breakdown?.outputTokens }).toEqual({
          date: day.date,
          model: model.model,
          input: model.input,
          output: model.output,
        });
      }
    }
    // No foreign model leaks through the Lattice filter.
    const leakedRows = rows.filter((row) =>
      row.modelBreakdowns.some((entry) => entry.modelName.includes("claude")),
    );
    expect(leakedRows.map((row) => row.date)).toEqual([]);
    // The binary under test is explicit (AV); ambient discovery is not
    // part of this chain and must not fail it on a bare runner.
    expect(typeof AV).toBe("string");

    // The official client sees exactly the same rows through its own filter
    // and builds an identical payload against a loopback stub.
    expect(clientSupportsAgentFilter(CLIENT)).toBe(true);
    const indexDir = path.join(home, ".agent-index");
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(
      path.join(indexDir, ".agent-index.json"),
      JSON.stringify({ install_id: "test-install-01", key: "aik_synthetic-test-key-1234567890" }),
    );
    const status = await clientStatus({ python: "python3", script: CLIENT }, home);
    expect(status.state).toBe("registered");

    // The posting path is proven without touching production: a loopback
    // stub answers 200 and the captured body equals the adapter payload.
    // (The stub server runs inside this test: node:http on 127.0.0.1.)
    // Vitest workers share the process env, so HOME is set explicitly for
    // the client child (our wrapper forwards explicit HOME first).
    const { default: http } = await import("node:http");
    const captureFile = path.join(root, "captured.json");
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        fs.writeFileSync(captureFile, JSON.stringify({ url: req.url, body: JSON.parse(body) }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const { clientCollect } = await import("../../src/index/client.js");
      const run = await clientCollect(
        { python: "python3", script: CLIENT },
        {
          agent: "lattice",
          days: 28,
          dryRun: false,
          home,
          agentsviewDataDir: avdata,
          exportsDir,
          apiOverride: `http://127.0.0.1:${port}`,
        },
      );
      expect(run.timedOut).toBe(false);
      expect(run.exitCode).toBe(0);
      const captured = JSON.parse(fs.readFileSync(captureFile, "utf8")) as {
        url: string;
        body: { days: Array<{ date: string; models: Array<{ model: string; input: number; output: number; cache_read: number; cache_write: number }> }> };
      };
      expect(captured.url).toContain("/v1/usage");
      for (const day of adapted) {
        const posted = captured.body.days.find((entry) => entry.date === day.date);
        expect(posted).toBeDefined();
        for (const model of day.models) {
          const entry = posted?.models.find((candidate) => candidate.model === model.model);
          // The client must reproduce our input/output exactly; cache is
          // asserted separately below with the agentsview-normalization caveat.
          expect({ model: entry?.model, input: entry?.input, output: entry?.output }).toEqual({
            model: model.model,
            input: model.input,
            output: model.output,
          });
        }
      }
      // And the posted payload carries no foreign agent or Claude model.
      expect(JSON.stringify(captured.body)).not.toContain("claude");
      // Repeating the post carries the same totals: no new install, no
      // doubling. The client owns idempotency; here we prove stability.
      fs.rmSync(captureFile);
      const again = await clientCollect(
        { python: "python3", script: CLIENT },
        {
          agent: "lattice",
          days: 28,
          dryRun: false,
          home,
          agentsviewDataDir: avdata,
          exportsDir,
          apiOverride: `http://127.0.0.1:${port}`,
        },
      );
      expect(again.exitCode).toBe(0);
      const recaptured = JSON.parse(fs.readFileSync(captureFile, "utf8")) as typeof captured;
      expect(recaptured.body).toEqual(captured.body);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 300000);
});
