import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EditTool } from "../../src/tools/edit.js";
import { contentVersion } from "../../src/tools/read.js";
import type { ToolContext } from "../../src/tools/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function workspace(files: Record<string, string>): ToolContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1edit-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { workspaceRoot: root, realm: "local-trusted", timeoutMs: 5000 };
}

function versionOf(context: ToolContext, name: string): string {
  return contentVersion(fs.readFileSync(path.join(context.workspaceRoot, name)));
}

// R1 edit durability (D-R1-04): atomic temp+rename replacement, preserved
// mode, serialized Lattice writers. RED on pre-R1 code (in-place truncate
// write, no lock, mode not preserved); GREEN after.
describe("r1 edit durability", () => {
  it("RED: replace is atomic (old-or-new) and preserves file mode", async () => {
    const context = workspace({ "a.txt": "hello world\n" });
    fs.chmodSync(path.join(context.workspaceRoot, "a.txt"), 0o640);
    const tool = new EditTool();
    const before = versionOf(context, "a.txt");
    const replaced = await tool.execute(
      { kind: "replace", path: "a.txt", expectedVersion: before, oldText: "world", newText: "there" },
      context,
    );
    expect(replaced.status).toBe("completed");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "a.txt"), "utf8")).toBe("hello there\n");
    // Mode preserved (atomic path copies mode to the temp file).
    expect(fs.statSync(path.join(context.workspaceRoot, "a.txt")).mode & 0o777).toBe(0o640);
    // No temp debris left behind.
    expect(fs.readdirSync(context.workspaceRoot).filter((f) => f.includes(".tmp") || f.endsWith(".new")).length).toBe(0);
  });

  it("RED: concurrent Lattice replaces on one path serialize (one wins, one stale)", async () => {
    // One shared tool instance (the runtime reuses toolsets per run): the
    // keyed mutex lives on the class, so any instance serializes. Awaiting
    // sequentially still exercises the stale path; Promise.all exercises
    // the interleave. Both orders must end old-or-new, never merged.
    const context = workspace({ "a.txt": "v0\n" });
    const tool = new EditTool();
    const before = versionOf(context, "a.txt");
    const p1 = tool.execute({ kind: "replace", path: "a.txt", expectedVersion: before, oldText: "v0", newText: "v1" }, context);
    // Yield so the second call chains behind the first lock holder.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const p2 = tool.execute({ kind: "replace", path: "a.txt", expectedVersion: before, oldText: "v0", newText: "v2" }, context);
    const [first, second] = await Promise.all([p1, p2]);
    // A stale-version denial still carries status "completed" (toolFailure
    // envelope) with errorKind set: count by errorKind, not by status.
    const stale = [first, second].filter((r) => r.errorKind === "stale-version");
    const clean = [first, second].filter((r) => r.errorKind === undefined);
    expect(clean).toHaveLength(1);
    expect(stale).toHaveLength(1);
    expect(stale[0]?.status).toBe("completed");
    const content = fs.readFileSync(path.join(context.workspaceRoot, "a.txt"), "utf8");
    expect(["v1\n", "v2\n"]).toContain(content);
  });

  it("create is atomic and leaves no partial file when the parent write races absence", async () => {
    const context = workspace({});
    const tool = new EditTool();
    const created = await tool.execute({ kind: "create", path: "sub/new.txt", content: "hi\n" }, context);
    expect(created.status).toBe("completed");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "sub", "new.txt"), "utf8")).toBe("hi\n");
    expect(fs.readdirSync(path.join(context.workspaceRoot, "sub")).filter((f) => f.includes(".tmp") || f.endsWith(".new")).length).toBe(0);
  });
});
