import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchTool } from "../../src/tools/search.js";
import { contentVersion, ReadTool } from "../../src/tools/read.js";
import type { ToolContext } from "../../src/tools/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function workspace(files: Record<string, string>): { root: string; context: ToolContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-tools-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { root, context: { workspaceRoot: root, realm: "local-trusted", timeoutMs: 5000 } };
}

describe("search", () => {
  it("finds literal text with scope, order and completeness", async () => {
    const { context } = workspace({
      "b.ts": "hello world\n",
      "a.ts": "say hello\nhello again\n",
    });
    const tool = new SearchTool();
    const result = await tool.execute({ kind: "text", query: "hello" }, context);
    expect(result.status).toBe("completed");
    expect(result.complete).toBe(true);
    expect(result.detail).toContain("a.ts:1:say hello");
    expect(result.summary).toContain("scope .");
  });

  it("reports incompleteness as a lower bound, never as absence", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i += 1) files[`f${i}.ts`] = "needle here\n";
    const { context } = workspace(files);
    const tool = new SearchTool();
    const result = await tool.execute({ kind: "text", query: "needle", maxMatches: 3 }, context);
    expect(result.complete).toBe(false);
    expect(result.truncated).toBe(true);
    expect(result.handleId).toBeDefined();
    expect(result.summary).toContain("proves nothing global");
    expect(result.truncationNote).toContain("lower bounds");
  });

  it("confines path search to the workspace and skips symlinks", async () => {
    const { root, context } = workspace({ "real/target.ts": "x\n" });
    try {
      fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    } catch {
      // Symlink creation needs privileges on some platforms; the confinement
      // assertions below hold either way.
    }
    const tool = new SearchTool();
    const escaped = await tool.execute({ kind: "path", query: "x", root: ".." }, context);
    expect(escaped.errorKind).toBe("invalid-args");
    const found = await tool.execute({ kind: "path", query: "target" }, context);
    expect(found.detail).toContain(path.join("real", "target.ts"));
    expect(found.detail).not.toContain("link");
  });

  it("rejects empty queries and invalid limits", async () => {
    const { context } = workspace({});
    const tool = new SearchTool();
    expect((await tool.execute({ kind: "text", query: "" }, context)).errorKind).toBe("invalid-args");
    expect((await tool.execute({ kind: "text", query: "x", maxMatches: 0 }, context)).errorKind).toBe("invalid-args");
  });
});

describe("read", () => {
  it("reads ranges with versions and detects the end of file", async () => {
    const { context } = workspace({ "a.txt": "one\ntwo\nthree\n" });
    const tool = new ReadTool();
    const first = await tool.execute({ path: "a.txt", start: 1, count: 2 }, context);
    expect(first.version).toMatch(/^sha256:/);
    expect(first.detail).toBe("1:one\n2:two");
    expect(first.truncated).toBe(true);
    expect(first.handleId).toBeDefined();
    const full = await tool.execute({ path: "a.txt" }, context);
    expect(full.complete).toBe(true);
    expect(full.detail).toContain("3:three");
  });

  it("identifies empty and binary files without rendering", async () => {
    const { root, context } = workspace({ "empty.txt": "" });
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0x00, 0x01, 0x02]));
    const tool = new ReadTool();
    const empty = await tool.execute({ path: "empty.txt" }, context);
    expect(empty.summary).toContain("empty file");
    expect(empty.detail).toBe("");
    const binary = await tool.execute({ path: "bin.dat" }, context);
    expect(binary.summary).toContain("binary file");
    expect(binary.detail).toBeUndefined();
  });

  it("pages long lines and expands them via handle", async () => {
    const { context } = workspace({ "long.txt": `${"a".repeat(20_000)}\nshort\n` });
    const tool = new ReadTool();
    const result = await tool.execute({ path: "long.txt", count: 1 }, context);
    expect(result.truncated).toBe(true);
    expect(result.detail).toContain("line truncated");
    expect(result.handleId).toBeDefined();
    if (result.handleId === undefined) throw new Error("expected a handle");
    const expanded = await tool.execute({ path: "long.txt", handleId: result.handleId }, context);
    expect(expanded.detail).toContain("short");
  });

  it("rejects escapes, missing files and bad ranges", async () => {
    const { context } = workspace({ "a.txt": "one\n" });
    const tool = new ReadTool();
    expect((await tool.execute({ path: "../outside.txt" }, context)).errorKind).toBe("invalid-args");
    expect((await tool.execute({ path: "missing.txt" }, context)).errorKind).toBe("not-found");
    expect((await tool.execute({ path: "a.txt", start: 99 }, context)).errorKind).toBe("invalid-args");
    expect((await tool.execute({ path: "a.txt", handleId: "h_nope" }, context)).errorKind).toBe("invalid-args");
  });

  it("versions change with content", async () => {
    const before = contentVersion(Buffer.from("one"));
    const after = contentVersion(Buffer.from("two"));
    expect(before).not.toBe(after);
  });
});
