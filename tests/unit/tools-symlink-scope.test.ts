import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SearchTool } from "../../src/tools/search.js";
import { contentVersion, ReadTool } from "../../src/tools/read.js";
import { EditTool } from "../../src/tools/edit.js";
import { ExecTool } from "../../src/tools/exec.js";
import type { ToolContext } from "../../src/tools/types.js";

// Symlink scope finding: lexical containment (path.resolve + startsWith)
// lets a symlink inside the workspace point outside of it, and the OS
// follows the link. Every tool below must refuse the external target while
// still serving the internal one.

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function layout(): { root: string; external: string; context: ToolContext; linked: boolean } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-symlink-"));
  dirs.push(base);
  const root = path.join(base, "workspace");
  const external = path.join(base, "external-target");
  fs.mkdirSync(path.join(root, "internal-target"), { recursive: true });
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(path.join(root, "internal-target", "inside.txt"), "inside\n");
  fs.writeFileSync(path.join(external, "secret.txt"), "outside\n");
  let linked = true;
  try {
    const type = process.platform === "win32" ? "junction" : "dir";
    fs.symlinkSync(path.join(root, "internal-target"), path.join(root, "internal-link"), type);
    fs.symlinkSync(external, path.join(root, "external-link"), type);
  } catch {
    linked = false;
  }
  return { root, external, context: { workspaceRoot: root, realm: "local-trusted", timeoutMs: 5000 }, linked };
}

describe("symlink scope confinement", () => {
  it("refuses reads through an external link but serves internal links", async () => {
    const { context, linked } = layout();
    if (!linked) {
      console.warn("symlinks unavailable; symlink scope test skipped");
      return;
    }
    const tool = new ReadTool();
    const outside = await tool.execute({ path: path.join("external-link", "secret.txt") }, context);
    expect(outside.errorKind).toBe("invalid-args");
    expect(outside.detail ?? outside.summary).not.toContain("outside");
    const inside = await tool.execute({ path: path.join("internal-link", "inside.txt") }, context);
    expect(inside.errorKind).toBeUndefined();
    expect(inside.detail).toContain("inside");
  });

  it("refuses edits through an external link", async () => {
    const { root, context, linked } = layout();
    if (!linked) {
      console.warn("symlinks unavailable; symlink scope test skipped");
      return;
    }
    const tool = new EditTool();
    const target = path.join("external-link", "secret.txt");
    const version = contentVersion(Buffer.from("outside\n", "utf8"));
    const attempt = await tool.execute(
      { kind: "replace", path: target, expectedVersion: version, oldText: "outside", newText: "pwned" },
      context,
    );
    expect(attempt.errorKind).toBe("invalid-args");
    expect(fs.readFileSync(path.join(root, "..", "external-target", "secret.txt"), "utf8")).toBe("outside\n");
  });

  it("refuses exec cwd through an external link", async () => {
    const { context, linked } = layout();
    if (!linked) {
      console.warn("symlinks unavailable; symlink scope test skipped");
      return;
    }
    const tool = new ExecTool();
    const result = await tool.execute(
      { executable: process.execPath, argv: ["-e", "process.exit(0)"], cwd: "external-link", timeoutMs: 5000 },
      context,
    );
    expect(result.errorKind).toBe("invalid-args");
  });

  it("refuses search roots through an external link", async () => {
    const { context, linked } = layout();
    if (!linked) {
      console.warn("symlinks unavailable; symlink scope test skipped");
      return;
    }
    const tool = new SearchTool();
    const result = await tool.execute({ kind: "text", query: "outside", root: "external-link" }, context);
    expect(result.errorKind).toBe("invalid-args");
    expect(result.detail ?? result.summary).not.toContain("outside");
  });
});
