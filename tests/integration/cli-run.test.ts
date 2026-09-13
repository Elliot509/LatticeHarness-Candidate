import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CLI = path.resolve(__dirname, "../../dist/cli/main.js");
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

describe("lattice run cli", () => {
  it("solves the fixture through the packaged entrypoint", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-cli-"));
    dirs.push(dir);
    const workspace = path.join(dir, "project");
    copyDir(FIXTURE, workspace);
    const noteBefore = fs.readFileSync(path.join(workspace, "notes", "todo.txt"), "utf8");

    const sumSource = fs.readFileSync(path.join(workspace, "src", "sum.js"), "utf8");
    const { createHash } = await import("node:crypto");
    const version = `sha256:${createHash("sha256").update(sumSource, "utf8").digest("hex").slice(0, 16)}`;
    const steps = [
      { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"discount\"}" }] },
      { toolCalls: [{ name: "read", argumentsJson: "{\"path\":\"src/sum.js\"}" }] },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["--test", "test/test.js"] }) }] },
      {
        toolCalls: [
          {
            name: "edit",
            argumentsJson: JSON.stringify({
              kind: "replace",
              path: "src/sum.js",
              expectedVersion: version,
              oldText: "  return items.reduce((sum, item) => {\n    const line = item.price * item.qty;\n    const discount = item.price > 50 ? item.price * 0.1 : 0;\n    return sum + line - discount;\n  }, 0);",
              newText: "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  const discount = subtotal > 100 ? subtotal * 0.1 : 0;\n  return subtotal - discount;",
            }),
          },
        ],
      },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["--test", "test/test.js"] }) }] },
      { text: "Fixed and verified." },
    ];
    const scriptPath = path.join(dir, "script.json");
    fs.writeFileSync(scriptPath, JSON.stringify(steps));

    const { stdout } = await execFileAsync(
      process.execPath,
      [
        CLI,
        "run",
        "--workspace", workspace,
        "--data-dir", path.join(dir, "data"),
        "--task", "Fix the bulk discount bug",
        "--accept", "project test suite passes",
        "--provider", "fake",
        "--model", "fake-model-1",
        "--fake-script", scriptPath,
        "--verify", process.execPath,
        "--verify-arg", "--test",
        "--verify-arg", "test/test.js",
      ],
      { cwd: dir },
    );
    expect(stdout).toContain("lattice: STOP: verified:");
    expect(stdout).toContain("passed=2, failed=0");
    expect(fs.readFileSync(path.join(workspace, "notes", "todo.txt"), "utf8")).toBe(noteBefore);
  }, 60_000);

  it("refuses the fake provider without a script and openai without a key", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-cli-"));
    dirs.push(dir);
    const base = [
      CLI, "run",
      "--workspace", dir,
      "--data-dir", path.join(dir, "data"),
      "--task", "x",
      "--model", "m",
    ];
    const fake = await execFileAsync(process.execPath, [...base, "--provider", "fake"], { cwd: dir }).catch((error: unknown) => error as { stdout: string });
    expect((fake as { stdout: string }).stdout).toContain("--fake-script");
    const openai = await execFileAsync(process.execPath, [...base, "--provider", "openai"], {
      cwd: dir,
      env: { ...process.env, LATTICE_API_KEY: "" },
    }).catch((error: unknown) => error as { stdout: string });
    expect((openai as { stdout: string }).stdout).toContain("LATTICE_API_KEY");
  }, 60_000);
});
