// R1 canary probe: synthetic secret must NOT reach tool children (F-0009).
// RED on current code for the process tool (inherits all of process.env).
import { describe, expect, it } from "vitest";
import { ExecTool } from "../../src/tools/exec.js";
import { ProcessSupervisor } from "../../src/tools/process.js";
import type { ToolContext } from "../../src/tools/types.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const NODE = process.execPath;
const CANARY_NAME = "LATTICE_R1_CANARY_SECRET";
const CANARY_VALUE = "canary-9f27b1";

function context(): { ctx: ToolContext; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1env-"));
  return { ctx: { workspaceRoot: dir, realm: "local-trusted", timeoutMs: 10_000 }, dir };
}

describe("r1 env boundary canary", () => {
  it("RED: process-spawned children must not observe runtime secrets", async () => {
    process.env[CANARY_NAME] = CANARY_VALUE;
    const { ctx, dir } = context();
    try {
      const supervisor = new ProcessSupervisor(ctx.workspaceRoot);
      try {
        const spawned = await supervisor.execute({
          op: "spawn", executable: NODE, argv: ["-e", `console.log(process.env[${JSON.stringify(CANARY_NAME)}] ?? "absent")`],
          generation: 1, realm: "local-trusted", attemptId: "a1",
        });
        const handle = spawned.handleId ?? "";
        let saw = "";
        for (let i = 0; i < 50; i += 1) {
          const polled = await supervisor.execute({ op: "poll", handle, timeoutMs: 200, generation: 1 });
          if (polled.detail !== undefined) saw += polled.detail;
          if (polled.status === "completed") break;
        }
        expect(saw).not.toContain(CANARY_VALUE);
      } finally {
        await supervisor.close();
      }
      const exec = new ExecTool();
      const out = await exec.execute(
        { executable: NODE, argv: ["-e", `console.log(process.env[${JSON.stringify(CANARY_NAME)}] ?? "absent")`] },
        ctx,
      );
      expect(out.detail ?? "").not.toContain(CANARY_VALUE);
    } finally {
      Reflect.deleteProperty(process.env, CANARY_NAME);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps PATH and HOME functional for normal builds", async () => {
    const { ctx, dir } = context();
    try {
      const exec = new ExecTool();
      const out = await exec.execute({ executable: NODE, argv: ["-e", "console.log('ok')"] }, ctx);
      expect(out.status).toBe("completed");
      expect(out.detail).toContain("ok");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
