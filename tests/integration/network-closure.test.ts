import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { OpenAiAdapter } from "../../src/providers/openai.js";

describe("uncertain provider failure closes the local activation", () => {
  it("preserves UNKNOWN without tools, automatic retries or active-runtime", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-network-closure-"));
    const root = path.join(dir, "ws"); fs.mkdirSync(root);
    const db = openLatticeDb(path.join(dir, "data")); const tasks = new TaskManager(db.raw, root);
    try {
      const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("synthetic transport failure"));
      const adapter = new OpenAiAdapter({ apiKey: "", baseUrl: "http://127.0.0.1:9", fetchImpl });
      const { taskId } = tasks.createTask({ workspace: ".", objective: 'Crie uma pasta chamada "aulas_ingles" dentro deste ambiente.', acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      tasks.startTask(taskId, "start", adapter);
      const deadline = Date.now() + 5000;
      while (tasks.snapshot(taskId).state === "RUNNING") {
        if (Date.now() > deadline) throw new Error("network closure deadline");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const snapshot = tasks.snapshot(taskId);
      expect(snapshot.state).toBe("BLOCKED"); expect(snapshot.stateReason).toContain("model invocation UNKNOWN");
      expect(snapshot.resumeBlockers).not.toContain("active-runtime"); expect(snapshot.resumable).toBe(false);
      expect(snapshot.unknowns).toBe(1); expect(snapshot.tools).toEqual([]);
      expect(snapshot.messages.some(m => m.source === "verified")).toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce(); expect(fs.existsSync(path.join(root, "aulas_ingles"))).toBe(false);
    } finally { await tasks.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
