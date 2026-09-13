import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import { runTaskLoop, type LoopOptions } from "../../src/runtime/loop.js";
import { openLatticeDb } from "../../src/storage/db.js";
import { FakeProvider, type FakeScriptStep } from "../../src/providers/fake.js";
import { READ_DEFINITION, ReadTool } from "../../src/tools/read.js";
import { SEARCH_DEFINITION, SearchTool } from "../../src/tools/search.js";
import { parseToolArgs } from "../../src/tools/types.js";
import type { TaskSurface } from "../../src/context/compiler.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function surface(): TaskSurface {
  return {
    objective: "Find where greeting is defined",
    acceptanceCriteria: ["greeting location observed"],
    grants: ["search, read under workspace"],
    prohibitions: ["publish"],
    obligations: ["preserve baseline"],
    unknowns: [],
    humanDecisions: [],
    versions: [],
    lastError: null,
  };
}

function setup(steps: FakeScriptStep[], files: Record<string, string>, extra?: Partial<LoopOptions>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-loop-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(workspace, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const opened = openLatticeDb(path.join(dir, "data"));
  const provider = new FakeProvider(steps);
  const search = new SearchTool();
  const read = new ReadTool();
  const contract = createContract({
    taskId: "task-1",
    rootId: "root-1",
    objective: "Find where greeting is defined",
    scope: ["workspace"],
    acceptanceCriteria: ["greeting location observed"],
    obligations: ["preserve baseline"],
    grants: [
      { subject: "agent", operations: ["search", "read", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
    ],
    prohibitions: ["publish"],
    realm: "local-trusted",
    allowedProvider: "fake",
    allowedModel: "fake-model-1",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    retentionPolicy: "retain until explicit deletion",
    origin: "test",
  });
  const options: LoopOptions = {
    db: opened.raw,
    provider,
    model: "fake-model-1",
    contract,
    sessionId: "session-test-1",
    runId: "run-test-1",
    taskSurface: surface(),
    tools: [
      {
        name: "search",
        definition: SEARCH_DEFINITION,
        run: async (argsJson, context) => {
          const parsed = parseToolArgs(argsJson);
          if (!parsed.ok) throw new Error(parsed.error);
          const args = parsed.value as unknown as Parameters<SearchTool["execute"]>[0];
          return { result: await search.execute(args, context), argsSummary: argsJson };
        },
      },
      {
        name: "read",
        definition: READ_DEFINITION,
        run: async (argsJson, context) => {
          const parsed = parseToolArgs(argsJson);
          if (!parsed.ok) throw new Error(parsed.error);
          const args = parsed.value as unknown as Parameters<ReadTool["execute"]>[0];
          return { result: await read.execute(args, context), argsSummary: argsJson };
        },
      },
    ],
    toolContext: { workspaceRoot: workspace, realm: "local-trusted", timeoutMs: 5000 },
    ownerGeneration: 1,
    grantedCalls: 50,
    grantedTokens: 200_000,
    maxIterations: 8,
    ...extra,
  };
  return { options, provider, close: () => opened.close() };
}

describe("task loop with search and read", () => {
  it("investigates with tools and asks when the model stalls unverified", async () => {
    const { options, provider, close } = setup(
      [
        { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"greet\"}" }] },
        { toolCalls: [{ name: "read", argumentsJson: "{\"path\":\"greet.ts\"}" }] },
        { text: "I found it, I think" },
      ],
      { "greet.ts": "export function greet() { return 'hi'; }\n" },
    );
    try {
      const stop = await runTaskLoop(options);
      expect(stop.decision).toBe("ASK");
      expect(stop.toolDispatches).toBe(2);
      expect(provider.consumedSteps).toBe(3);
      const receipts = options.db.prepare("SELECT COUNT(*) AS n FROM receipts").get() as { n: number };
      expect(receipts.n).toBeGreaterThanOrEqual(5);
    } finally {
      close();
    }
  });

  it("stops only with acceptance evidence, never on bare text", async () => {
    const { options, close } = setup([{ text: "all done, trust me" }], { "greet.ts": "hi\n" });
    try {
      const stalled = await runTaskLoop(options);
      expect(stalled.decision).toBe("ASK");
    } finally {
      close();
    }
    const { options: options2, close: close2 } = setup(
      [{ text: "verified by test run" }],
      { "greet.ts": "hi\n" },
      {
        acceptanceVerifiers: [() => ({ complete: true, reason: "verify command passed at workspace revision abc" })],
      },
    );
    try {
      const done = await runTaskLoop(options2);
      expect(done.decision).toBe("STOP");
      expect(done.reason).toContain("verify command passed");
    } finally {
      close2();
    }
  });

  it("escalates when the budget is exhausted", async () => {
    const { options, close } = setup(
      [{ toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"x\"}" }] }],
      { "a.ts": "x\n" },
      { grantedCalls: 1, grantedTokens: 100 },
    );
    try {
      const stop = await runTaskLoop(options);
      expect(stop.decision).toBe("ESCALATE");
      expect(stop.reason).toContain("budget");
    } finally {
      close();
    }
  });

  it("stops on user interrupt without dispatching further", async () => {
    const controller = new AbortController();
    controller.abort();
    const { options, close } = setup(
      [{ toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"x\"}" }] }],
      { "a.ts": "x\n" },
      { signal: controller.signal },
    );
    try {
      const stop = await runTaskLoop(options);
      expect(stop.decision).toBe("STOP");
      expect(stop.reason).toContain("interrupted");
      expect(stop.toolDispatches).toBe(0);
    } finally {
      close();
    }
  });

  it("reports unknown tools and refuses identical repeats without progress", async () => {
    const { options, close } = setup(
      [
        { toolCalls: [{ name: "nope", argumentsJson: "{}" }] },
        { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"x\"}" }] },
        { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"x\"}" }] },
        { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"x\"}" }] },
        { text: "stuck" },
      ],
      { "a.ts": "x\n" },
    );
    try {
      const stop = await runTaskLoop(options);
      expect(["ASK", "ESCALATE"]).toContain(stop.decision);
      const seen = options.db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number };
      expect(seen.n).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it("blocks blind retry while the first attempt stays UNKNOWN", async () => {
    const { options, close } = setup(
      [
        { toolCalls: [{ name: "flaky", argumentsJson: "{}" }] },
        { toolCalls: [{ name: "flaky", argumentsJson: "{}" }] },
        { text: "stuck" },
      ],
      { "a.ts": "x\n" },
    );
    options.tools.push({
      name: "flaky",
      definition: { name: "flaky", description: "always uncertain", parameters: { type: "object", properties: {} } },
      run: async () => ({
        result: { status: "unknown", summary: "effect uncertain" },
        argsSummary: "{}",
      }),
    });
    // Grant the stub tool for this run.
    options.contract = {
      ...options.contract,
      grants: [
        ...options.contract.grants,
        { subject: "agent", operations: ["flaky"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
    };
    try {
      const stop = await runTaskLoop(options);
      expect(["ASK", "ESCALATE"]).toContain(stop.decision);
      const dispatched = options.db.prepare(
        "SELECT COUNT(*) AS n FROM attempts WHERE intent_id IN (SELECT intent_id FROM intents WHERE operation = 'flaky')",
      ).get() as { n: number };
      expect(dispatched.n).toBe(1);
      const unknowns = options.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE outcome = 'unknown'").get() as { n: number };
      expect(unknowns.n).toBe(1);
    } finally {
      close();
    }
  });
});
