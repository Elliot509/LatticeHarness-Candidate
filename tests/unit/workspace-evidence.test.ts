import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAcceptance, sameObservedFile, TaskAcceptance, workspaceVersion } from "../../src/runtime/acceptance.js";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function workspace(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-evidence-")); dirs.push(dir); return dir; }
const pass = { status: "completed" as const, summary: "exit 0", detail: "ok 1 - real fixture" };

describe("content evidence at verification boundaries", () => {
  it("handles Windows path-stat's missing device while rejecting swapped or unknown file IDs", () => {
    const pathStat = { ino: 123n, dev: 0n }, handleStat = { ino: 123n, dev: 456n };
    expect(sameObservedFile(pathStat, handleStat, "win32")).toBe(true);
    expect(sameObservedFile(pathStat, handleStat, "linux")).toBe(false);
    expect(sameObservedFile({ ino: 123n, dev: 789n }, handleStat, "win32")).toBe(false);
    expect(sameObservedFile({ ino: 124n, dev: 0n }, handleStat, "win32")).toBe(false);
    expect(sameObservedFile({ ino: 0n, dev: 0n }, { ino: 0n, dev: 456n }, "win32")).toBe(false);
  });
  // Setup creates up to 10,001 files, then prepare/observe/check each make
  // an independently capped observation. Budget the whole fixture separately;
  // the production 30-second deadline and every assertion remain unchanged.
  it.each(["bytes", "entries"])("verifies a project beyond the old %s ceiling", async kind => {
    const root = workspace();
    if (kind === "bytes") fs.writeFileSync(path.join(root, "large.bin"), Buffer.alloc(33 * 1024 * 1024));
    else for (let i = 0; i < 10_001; i++) fs.writeFileSync(path.join(root, `file-${i}`), "x");
    const verifier = new TaskAcceptance(root, ["tests-pass"]);
    await verifier.prepare("exec");
    await verifier.observe("exec", "test fixture", pass);
    expect((await verifier.check()).complete).toBe(true);
  }, 120_000);

  it("frames path, kind, mode, size and content so the old concatenation collision differs", async () => {
    const a = workspace(), b = workspace();
    fs.writeFileSync(path.join(a, "a"), "bc"); fs.writeFileSync(path.join(a, "d"), "e");
    fs.writeFileSync(path.join(b, "a"), "b"); fs.writeFileSync(path.join(b, "cd"), "e");
    const left = await workspaceVersion(a), right = await workspaceVersion(b);
    expect(left.version).not.toBeNull(); expect(right.version).not.toBe(left.version);
  });

  it("unknown observations never certify a test pass", async () => {
    const root = workspace();
    expect(await workspaceVersion(root, { maxDurationMs: 0 })).toMatchObject({ version: null });
    const verifier = new TaskAcceptance(root, ["tests-pass"]);
    await verifier.observe("exec", "unprepared", pass);
    expect((await verifier.check()).complete).toBe(false);
    fs.rmSync(root, { recursive: true });
    expect((await workspaceVersion(root)).version).toBeNull();
  });

  it("rejects cancellation and changes during tests and accepts a fresh rerun", async () => {
    const root = workspace(), file = path.join(root, "code.js"); fs.writeFileSync(file, "before");
    const verifier = new TaskAcceptance(root, ["tests-pass"]);
    await verifier.prepare("exec"); fs.writeFileSync(file, "during"); await verifier.observe("exec", "fixture", pass);
    expect((await verifier.check()).complete).toBe(false);
    await verifier.prepare("exec"); await verifier.observe("exec", "fixture", pass);
    expect((await verifier.check()).complete).toBe(true);
    expect((await workspaceVersion(root, { signal: AbortSignal.abort() })).version).toBeNull();
  });

  it("detects external content changes even with equal size and restored mtime", async () => {
    const root = workspace(), file = path.join(root, "code.js"); fs.writeFileSync(file, "before");
    const verifier = new TaskAcceptance(root, ["tests-pass"]);
    await verifier.prepare("exec"); await verifier.observe("exec", "fixture", pass);
    const stamp = fs.statSync(file); fs.writeFileSync(file, "after!"); fs.utimesSync(file, stamp.atime, stamp.mtime);
    expect(await verifier.check()).toMatchObject({ complete: false });
    expect((await verifier.check()).reason).toContain("code.js");
  });

  it("does no workspace content I/O for 100 read/search observations in a moderate project", async () => {
    const root = workspace(); for (let i = 0; i < 500; i++) fs.writeFileSync(path.join(root, `item-${i}`), Buffer.alloc(8192));
    const opened = vi.spyOn(fs.promises, "open");
    const verifier = new TaskAcceptance(root, ["tests-pass"]);
    for (let i = 0; i < 100; i++) { await verifier.prepare(i % 2 ? "search" : "read"); await verifier.observe("read", "{}", { status: "completed", summary: "observed" }); }
    expect(opened).not.toHaveBeenCalled();
  });

  it.each([
    ["Crie uma pasta chamada Muse.", "directory-exists:Muse"],
    ["Crie a pasta Muse neste projeto.", "directory-exists:Muse"],
    ["Crie um arquivo chamado teste.txt.", "file-exists:teste.txt"],
    ["Leia este arquivo e explique seu conteúdo.", "response"],
    ["Corrija o código e execute testes.", "tests-pass"],
  ])("keeps the narrow acceptance contract for %s", (objective, criterion) => { expect(defaultAcceptance(objective as string)).toEqual([criterion]); });
});
