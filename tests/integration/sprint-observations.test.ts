import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReadTool } from "../../src/tools/read.js";
import { EditTool } from "../../src/tools/edit.js";
import { HandleRegistry } from "../../src/tools/handles.js";
import { armFault, clearFaults } from "../../src/runtime/faults.js";

afterEach(clearFaults);
describe("bounded observations and uncertain writes", () => {
  it("exposes the suffix of a long line through a byte range and rejects stale expansion", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-observation-"));
    try {
      const tool = new ReadTool(); const context = { workspaceRoot: root, realm: "local-trusted" };
      fs.writeFileSync(path.join(root, "long"), "x".repeat(20_000) + "SUFFIX");
      const first = await tool.execute({ path: "long" }, context);
      expect(first).toMatchObject({ complete: false, truncated: true });
      if (first.handleId === undefined) throw new Error("expected expansion handle");
      expect((await tool.execute({ path: "long", offset: 20_000, maxBytes: 6 }, context)).detail).toBe("SUFFIX");
      expect((await tool.execute({ path: "long", handleId: first.handleId }, context)).detail).toContain("SUFFIX");
      fs.appendFileSync(path.join(root, "long"), "changed");
      expect((await tool.execute({ path: "long", handleId: first.handleId }, context)).errorKind).toBe("stale-version");
      const handles = new HandleRegistry(); let oldest = "";
      for (let n = 0; n < 65; n++) { const id = handles.store("read", "bounded", () => "text"); if (n === 0) oldest = id; }
      expect(handles.size()).toBe(64); expect(handles.get(oldest)).toBeUndefined();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it("keeps a real applied edit UNKNOWN when post-effect observation fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-post-effect-"));
    try {
      armFault("after-edit-effect");
      const result = await new EditTool().execute({ kind: "create", path: "created", content: "preserved" }, { workspaceRoot: root, realm: "local-trusted" });
      expect(result).toMatchObject({ status: "unknown", effectUncertain: true, errorRetryable: false });
      expect(fs.readFileSync(path.join(root, "created"), "utf8")).toBe("preserved");
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
