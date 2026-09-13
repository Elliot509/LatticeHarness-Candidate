import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import { taskBudgetSnapshot } from "../../src/runtime/effects.js";
import { runTaskLoop, type LoopOptions } from "../../src/runtime/loop.js";
import { VerifyLedger } from "../../src/runtime/verify.js";
import { openLatticeDb } from "../../src/storage/db.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { buildToolset } from "../../src/tools/registry.js";
import { contentVersion } from "../../src/tools/read.js";
import { ProcessSupervisor } from "../../src/tools/process.js";
import type { TaskSurface } from "../../src/context/compiler.js";

const FIXTURE = path.resolve(__dirname, "../../fixtures/bug-prices");

let dirs: string[] = [];
afterEach(() => {
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

describe("fixture end to end", () => {
  it("investigates, fixes, verifies and preserves human work", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-fixture-"));
    dirs.push(dir);
    const workspace = path.join(dir, "project");
    copyDir(FIXTURE, workspace);

    const humanNote = path.join(workspace, "notes", "todo.txt");
    const humanFormat = path.join(workspace, "src", "format.js");
    const noteBefore = fs.readFileSync(humanNote, "utf8");
    const formatBefore = fs.readFileSync(humanFormat, "utf8");
    const sumPath = path.join(workspace, "src", "sum.js");
    const sumVersion = contentVersion(fs.readFileSync(sumPath));

    const opened = openLatticeDb(path.join(dir, "data"));
    const supervisor = new ProcessSupervisor(workspace);
    const ledger = new VerifyLedger();
    const nodeExe = process.execPath;
    const provider = new FakeProvider([
      { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"discount\"}" }] },
      { toolCalls: [{ name: "read", argumentsJson: "{\"path\":\"src/sum.js\"}" }] },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
      {
        toolCalls: [
          {
            name: "edit",
            argumentsJson: JSON.stringify({
              kind: "replace",
              path: "src/sum.js",
              expectedVersion: sumVersion,
              oldText: "  return items.reduce((sum, item) => {\n    const line = item.price * item.qty;\n    const discount = item.price > 50 ? item.price * 0.1 : 0;\n    return sum + line - discount;\n  }, 0);",
              newText: "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  const discount = subtotal > 100 ? subtotal * 0.1 : 0;\n  return subtotal - discount;",
            }),
          },
        ],
      },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
      { text: "Fixed the bulk discount and verified with the project tests." },
    ]);
    const contract = createContract({
      taskId: "task-1",
      rootId: "root-1",
      objective: "Fix the bulk discount bug",
      scope: ["workspace"],
      acceptanceCriteria: ["project test suite passes"],
      obligations: ["preserve human files"],
      grants: [
        { subject: "agent", operations: ["search", "read", "edit", "exec", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: ["publish"],
      realm: "local-trusted",
      allowedProvider: "fake",
      allowedModel: "fake-model-1",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "test",
    });
    const taskSurface: TaskSurface = {
      objective: "Fix the bulk discount bug",
      acceptanceCriteria: ["project test suite passes"],
      grants: ["search/read/edit/exec under workspace"],
      prohibitions: ["publish"],
      obligations: ["preserve human files"],
      unknowns: [],
      humanDecisions: [],
      versions: [],
      lastError: null,
    };
    const options: LoopOptions = {
      db: opened.raw,
      provider,
      model: "fake-model-1",
      contract,
      sessionId: "session-fixture-1",
      runId: "run-fixture-1",
      taskSurface,
      tools: buildToolset({
        supervisor,
        verifyTriggers: [{ executable: nodeExe, argv: ["--test", "test/test.js"], onResult: (result) => ledger.record(result) }],
      }),
      toolContext: { workspaceRoot: workspace, realm: "local-trusted", timeoutMs: 30_000 },
      ownerGeneration: 1,
      grantedCalls: 50,
      grantedTokens: 200_000,
      maxIterations: 12,
      acceptanceVerifiers: [() => ledger.check()],
    };
    try {
      const stop = await runTaskLoop(options);
      expect(stop.decision).toBe("STOP");
      expect(stop.reason).toContain("passed=");
      expect(stop.toolDispatches).toBe(5);

      const fixed = (await import(`${pathToFileURL(sumPath).href}?t=${Date.now()}`)) as {
        total: (items: Array<{ price: number; qty: number }>) => number;
      };
      expect(fixed.total([{ price: 60, qty: 2 }])).toBe(108);
      expect(fs.readFileSync(humanNote, "utf8")).toBe(noteBefore);
      expect(fs.readFileSync(humanFormat, "utf8")).toBe(formatBefore);

      const receipts = opened.raw.prepare("SELECT outcome, COUNT(*) AS n FROM receipts GROUP BY outcome").all() as Array<{ outcome: string; n: number }>;
      const byOutcome = new Map(receipts.map((row) => [row.outcome, row.n]));
      expect(byOutcome.get("confirmed") ?? 0).toBeGreaterThanOrEqual(10);
      expect(byOutcome.get("unknown") ?? 0).toBe(0);

      const budget = taskBudgetSnapshot(opened.raw, "task-1", { calls: 50, tokens: 200_000 });
      expect(budget.settled.calls + budget.reserved.calls).toBeLessThanOrEqual(50);
      expect(budget.settled.tokens + budget.reserved.tokens).toBeLessThanOrEqual(200_000);
    } finally {
      await supervisor.close();
      opened.close();
    }
  });
});
