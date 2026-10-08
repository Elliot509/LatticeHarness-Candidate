import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { startDesktopBackend } from "../../src/desktop/backend.js";
import { TaskManager } from "../../src/server/tasks.js";
import { desktopOptions } from "../../src/desktop/options.js";
import { defaultProductConfig, saveProductConfig } from "../../src/productConfig.js";

describe("demo project and session credential boundaries", () => {
  it("starts with no implicit project, selects a canonical root, and preserves earlier task scope", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-demo-"));
    const first = path.join(dir, "first café"), second = path.join(dir, "second");
    fs.mkdirSync(first); fs.mkdirSync(second);
    const backend = await startDesktopBackend({ workspace: "", dataDir: path.join(dir, "data"), nativeProjectSelection: true });
    const options = { workspace: "", objective: "read", acceptance: [], provider: "local", model: "fixture", baseUrl: null };
    try {
      expect(backend.tasks.serverWorkspace).toBe("");
      expect(() => backend.tasks.createTask(options)).toThrow(/choose a project/);
      expect(() => backend.tasks.selectNativeWorkspace(os.homedir())).toThrow(/project folder/);
      expect(() => backend.tasks.selectNativeWorkspace(path.parse(first).root)).toThrow(/project folder/);
      backend.tasks.selectNativeWorkspace(first);
      const created = backend.tasks.createTask(options);
      const before = backend.tasks.snapshot(created.taskId);
      backend.tasks.selectNativeWorkspace(second);
      expect(backend.tasks.snapshot(created.taskId).workspace).toBe(before.workspace);
      expect(before.workspace).toBe(fs.realpathSync.native(first));
      expect(() => backend.tasks.resolveWorkspacePath(first)).toThrow(/inside/);
      const cli = new TaskManager(backend.db.raw, first);
      expect(() => cli.selectNativeWorkspace(second)).toThrow(/unavailable/);
      await cli.close();
      expect(() => cli.selectNativeWorkspace(second)).toThrow(/unavailable/);
    } finally { await backend.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("isolates endpoint keys, withholds echoed provider errors, leaves storage secret-free and forgets keys on close", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-key-"));
    const key = "synthetic-session-canary-not-a-real-key";
    let seenAuth = false;
    const fixture = http.createServer((request, response) => {
      seenAuth = request.headers.authorization === `Bearer ${key}`;
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: key } }));
    });
    await new Promise<void>(resolve => { fixture.listen(0, "127.0.0.1", resolve); });
    const endpoint = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/v1`;
    const backend = await startDesktopBackend({ workspace: dir, dataDir: path.join(dir, "data") });
    try {
      backend.tasks.setKey("custom", key, endpoint + "/");
      expect(backend.tasks.providerApiKey("custom", endpoint)).toBe(key);
      expect(backend.tasks.providerApiKey("custom", endpoint + "/other")).toBe("");
      expect(backend.tasks.keyConfigured("custom", endpoint)).toBe(true);
      expect(() => backend.tasks.setKey("custom", key, "http://example.test/v1")).toThrow(/HTTPS/);
      expect(() => backend.tasks.setKey("custom", key, endpoint + "?key=" + key)).toThrow();
      const product = { ...defaultProductConfig(), defaultProviderId: "custom", defaultModel: "fixture", defaultBaseUrl: endpoint };
      saveProductConfig(path.join(dir, "data"), product);
      expect(() => saveProductConfig(dir, { ...product, defaultBaseUrl: endpoint + "?key=" + key })).toThrow();
      const task = backend.tasks.createTask({ workspace: dir, objective: "small", acceptance: [], provider: "custom", model: "fixture", baseUrl: endpoint });
      expect(backend.tasks.startTask(task.taskId, "key-test-start").accepted).toBe(true);
      const deadline = Date.now() + 5000;
      while (backend.tasks.activeTaskCount !== 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(backend.tasks.activeTaskCount).toBe(0);
      expect(seenAuth).toBe(true);
      expect(JSON.stringify(backend.tasks.snapshot(task.taskId))).not.toContain(key);
      for (const row of backend.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>) {
        expect(JSON.stringify(backend.db.raw.prepare(`SELECT * FROM "${row.name}"`).all())).not.toContain(key);
      }
      expect(fs.readFileSync(path.join(dir, "data", "lattice.product.json"), "utf8")).not.toContain(key);
      await backend.close();
      expect(backend.tasks.keyConfigured("custom", endpoint)).toBe(false);
      const reopened = await startDesktopBackend({ workspace: dir, dataDir: path.join(dir, "data") });
      try { expect(reopened.tasks.keyConfigured("custom", endpoint)).toBe(false); expect(reopened.tasks.snapshot(task.taskId).objective).toBe("small"); }
      finally { await reopened.close(); }
    } finally { await backend.close(); await new Promise<void>(resolve => { fixture.close(() => { resolve(); }); }); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("resolves desktop storage without adopting the launch directory as a project", () => {
    const options = desktopOptions({ XDG_DATA_HOME: "/tmp/lattice-user-data" });
    expect(options).toEqual({ workspace: "", dataDir: "/tmp/lattice-user-data/lattice", browserDir: "/tmp/lattice-user-data/lattice/browser-state" });
  });
});
