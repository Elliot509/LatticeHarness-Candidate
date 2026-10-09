import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { createContract } from "../../src/runtime/contract.js";
import { runTaskLoop } from "../../src/runtime/loop.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { buildToolset } from "../../src/tools/registry.js";

async function probes(kind: "presentation" | "content" | "exit") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-progress-"));
  const root = path.join(dir, "project"); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "probe"), kind === "exit" ? "0" : "x".repeat(5000) + "before");
  const db = openLatticeDb(path.join(dir, "data"));
  const contract = createContract({ taskId: "t", rootId: "r", objective: "Observe", scope: [root], acceptanceCriteria: ["tests-pass"], obligations: ["preserve work"], grants: [{ subject: "agent", operations: ["model.invoke", "exec"], targets: [root], expiresAt: null, limits: { maxCalls: null, maxTokens: null } }], prohibitions: [], realm: "local-trusted", allowedProvider: "fake", allowedModel: "m", expiresAt: null, retentionPolicy: "discard synthetic", origin: "fixture" });
  const program = kind === "exit" ? "process.exit(Number(require('fs').readFileSync('probe','utf8')))" : "process.stdout.write(require('fs').readFileSync('probe','utf8'))";
  const args = { executable: process.execPath, argv: ["-e", program], cwd: ".", env: { LATTICE_FIXTURE_A: "a", LATTICE_FIXTURE_B: "b" } };
  const reordered = { env: { LATTICE_FIXTURE_B: "b", LATTICE_FIXTURE_A: "a" }, cwd: ".", argv: args.argv, executable: args.executable };
  const provider = new FakeProvider(Array.from({ length: 12 }, (_, i) => ({ toolCalls: [{ name: "exec", argumentsJson: JSON.stringify(i % 2 ? reordered : args, null, i % 2 ? 2 : 0) }], usage: { inputTokens: 10, outputTokens: 5 } })));
  const tools = buildToolset().filter(tool => tool.name === "exec");
  const exec = tools[0]; if (!exec) throw new Error("missing exec");
  const run = exec.run; let dispatches = 0;
  exec.run = async (...params) => {
    const out = await run(...params); dispatches++;
    // Only the human-facing presentation varies; this is not a fabricated
    // tool result. The executor's substantive output identity is unchanged.
    out.result.summary = dispatches % 2 ? `exit ${kind === "exit" && dispatches > 2 ? 1 : 0} in ${dispatches}ms` : `formatted presentation ${dispatches}`;
    return out;
  };
  try {
    const stop = await runTaskLoop({ db: db.raw, contract, provider, model: "m", sessionId: "s", runId: "run", ownerGeneration: 1, grantedCalls: null, grantedTokens: null, maxIterations: 12,
      tools, toolContext: { workspaceRoot: root, realm: "local-trusted" },
      taskSurface: { objective: "Observe", acceptanceCriteria: ["tests-pass"], grants: ["exec"], prohibitions: [], obligations: [], unknowns: [], humanDecisions: [], versions: [], lastError: null },
      beforeRequest: () => { if (kind !== "presentation" && provider.requests.length === 2) fs.writeFileSync(path.join(root, "probe"), kind === "exit" ? "1" : "x".repeat(5000) + "changed"); },
      acceptanceVerifiers: [() => ({ complete: false, reason: "no test evidence" })],
    });
    const expected = kind === "presentation" ? 5 : 7;
    expect(stop).toMatchObject({ decision: "ASK", modelCalls: expected, toolDispatches: expected });
    expect(stop.reason).toContain("no progress");
    const receipts = db.raw.prepare("SELECT detail FROM receipts WHERE json_extract(detail,'$.detail') LIKE '%observationKey%' ORDER BY recorded_at").all() as Array<{ detail: string }>;
    expect(receipts).toHaveLength(expected);
    const keys = receipts.map(r => (JSON.parse(JSON.parse(r.detail).detail) as { observationKey: string }).observationKey);
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(kind === "presentation" ? 1 : 2);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

describe("substantive progress rather than incidental presentation", () => {
  it("stops the same observation despite JSON whitespace, nested key order and elapsed/presentation changes", async () => { await probes("presentation"); });
  it("preserves a real output change beyond the rendered 4000-character prefix", async () => { await probes("content"); });
  it("preserves a changed exit status even with identical stdout", async () => { await probes("exit"); });
});
