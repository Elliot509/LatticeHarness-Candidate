import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { SCHEMA_VERSION } from "../../src/storage/schema.js";
import { DESKTOP_BACKEND_PROTOCOL, startDesktopBackend } from "../../src/desktop/backend.js";

let dirs: string[] = [];
let backends: Array<{ close(): Promise<void> }> = [];
let children: Array<ReturnType<typeof fork>> = [];
afterEach(async () => {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  children = [];
  for (const backend of backends) {
    try {
      await backend.close();
    } catch {
      // Best effort cleanup.
    }
  }
  backends = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function scratch(): { dir: string; workspace: string; dataDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-desktop-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  return { dir, workspace, dataDir: path.join(dir, "data") };
}

function waitForIpc(child: ReturnType<typeof fork>, predicate: (message: unknown) => boolean, timeoutMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error("timed out waiting for backend ipc"));
    }, timeoutMs);
    const onMessage = (message: unknown): void => {
      if (predicate(message)) {
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(message);
      }
    };
    child.on("message", onMessage);
  });
}

describe("desktop backend entry", () => {
  it("opens the real database with WAL/FULL, migrates and serves authenticated HTTP", async () => {
    const { workspace, dataDir } = scratch();
    const backend = await startDesktopBackend({ workspace, dataDir });
    backends.push(backend);
    const dbPath = path.join(dataDir, "lattice.db");
    expect(fs.existsSync(dbPath)).toBe(true);
    const probe = new DatabaseSync(dbPath);
    try {
      expect(probe.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      expect(probe.prepare("PRAGMA synchronous").get()).toMatchObject({ synchronous: 2 });
      expect(probe.prepare("SELECT value AS v FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
        v: String(SCHEMA_VERSION),
      });
    } finally {
      probe.close();
    }
    const home = await fetch(`${backend.server.url}/`, { headers: { Cookie: backend.server.bootstrapCookie } });
    expect(home.status).toBe(200);
    const cookie = backend.server.bootstrapCookie;
    expect(cookie).not.toBe("");
    const denied = await fetch(`${backend.server.url}/api/sessions`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${backend.server.url}/api/sessions`, { headers: { Cookie: cookie } });
    expect(allowed.status).toBe(200);
    const created = (await (
      await fetch(`${backend.server.url}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          commandId: "desk-create-1",
          kind: "create-task",
          payload: { workspace: "", objective: "Desktop smoke task", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
        }),
      })
    ).json()) as { accepted: boolean; taskId: string };
    expect(created.accepted).toBe(true);
    const snapshot = (await (
      await fetch(`${backend.server.url}/api/tasks/${created.taskId}/snapshot`, { headers: { Cookie: cookie } })
    ).json()) as { objective: string; state: string };
    expect(snapshot.objective).toBe("Desktop smoke task");
    expect(snapshot.state).toBe("READY");
  });

  it("rejects a future schema version instead of resetting it", async () => {
    const { workspace, dataDir } = scratch();
    fs.mkdirSync(dataDir, { recursive: true });
    const seeded = new DatabaseSync(path.join(dataDir, "lattice.db"));
    try {
      seeded.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      seeded.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION + 1));
    } finally {
      seeded.close();
    }
    await expect(startDesktopBackend({ workspace, dataDir })).rejects.toThrow(/newer than supported/);
  });

  it("migrates a genuine v1 database and keeps its rows", async () => {
    const { workspace, dataDir } = scratch();
    const { V1_SCHEMA_SQL } = await import("../../src/storage/schema.js");
    fs.mkdirSync(dataDir, { recursive: true });
    const v1 = new DatabaseSync(path.join(dataDir, "lattice.db"));
    try {
      v1.exec(V1_SCHEMA_SQL);
      v1.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
      v1.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        "task-keep",
        "root-keep",
        1,
        JSON.stringify({ taskId: "task-keep", objective: "pre-desktop work" }),
        new Date().toISOString(),
      );
    } finally {
      v1.close();
    }
    const backend = await startDesktopBackend({ workspace, dataDir });
    backends.push(backend);
    const reopened = new DatabaseSync(path.join(dataDir, "lattice.db"));
    try {
      expect(reopened.prepare("SELECT value AS v FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
        v: String(SCHEMA_VERSION),
      });
      const kept = reopened.prepare("SELECT document AS d FROM contracts WHERE task_id = 'task-keep'").get() as { d: string };
      expect(kept.d).toContain("pre-desktop work");
      expect(reopened.prepare("SELECT name AS n FROM sqlite_master WHERE type = 'table' AND name = 'waits'").get()).toMatchObject({ n: "waits" });
    } finally {
      reopened.close();
    }
  });

  it("speaks the typed IPC handshake and answers commands over it", async () => {
    const { workspace, dataDir } = scratch();
    const entry = new URL("../../dist/desktop/backend-entry.js", import.meta.url);
    const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    const hello = (await waitForIpc(child, (message) => (message as { type?: unknown }).type === "lattice-backend-hello")) as {
      protocol: number;
    };
    expect(hello.protocol).toBe(DESKTOP_BACKEND_PROTOCOL);
    const startId = 1;
    child.send({ id: startId, op: "start", config: { workspace, dataDir } });
    const ready = (await waitForIpc(
      child,
      (message) => (message as { id?: unknown; type?: unknown }).id === startId,
    )) as { type: string; url: string; port: number; protocol: number; bootstrapCookie: string };
    expect(ready.type).toBe("lattice-backend-ready");
    expect(ready.protocol).toBe(DESKTOP_BACKEND_PROTOCOL);
    expect(ready.port).toBeGreaterThan(0);
    const home = await fetch(`${ready.url}/`, { headers: { Cookie: ready.bootstrapCookie } });
    expect(home.status).toBe(200);
    const cookie = ready.bootstrapCookie;
    const created = (await (
      await fetch(`${ready.url}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          commandId: "desk-ipc-1",
          kind: "create-task",
          payload: { workspace: "", objective: "IPC task", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
        }),
      })
    ).json()) as { accepted: boolean };
    expect(created.accepted).toBe(true);
    const stopId = 2;
    child.send({ id: stopId, op: "stop" });
    const stopped = (await waitForIpc(
      child,
      (message) => (message as { id?: unknown; type?: unknown }).id === stopId,
    )) as { type: string };
    expect(stopped.type).toBe("lattice-backend-stopped");
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 500));
    await expect(fetch(`${ready.url}/`, { headers: { Cookie: ready.bootstrapCookie } })).rejects.toThrow();
  });

  it("closes the listener and releases the database on shutdown", async () => {
    const { workspace, dataDir } = scratch();
    const backend = await startDesktopBackend({ workspace, dataDir });
    const url = backend.server.url;
    const port = backend.server.port;
    await backend.close();
    backends = backends.filter((entry) => entry !== backend);
    await expect(fetch(`${url}/`)).rejects.toThrow();
    const reopened: LatticeDb = openLatticeDb(dataDir);
    try {
      expect(reopened.raw.prepare("SELECT value AS v FROM meta WHERE key = 'schema_version'").get()).toMatchObject({
        v: String(SCHEMA_VERSION),
      });
    } finally {
      reopened.close();
    }
    void port;
  });
});
