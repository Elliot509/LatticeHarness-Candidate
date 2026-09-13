import fs from "node:fs";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership, type LatticeDb } from "../../src/storage/db.js";
import { serveLattice, type LatticeServer } from "../../src/server/server.js";
import { TaskManager } from "../../src/server/tasks.js";

let dirs: string[] = [];
let handles: LatticeDb[] = [];
let servers: LatticeServer[] = [];
let fixtures: HttpServer[] = [];
afterEach(async () => {
  for (const server of servers) {
    try {
      await server.close();
    } catch {
      // Best effort cleanup.
    }
  }
  servers = [];
  for (const fixture of fixtures) {
    await new Promise<void>((resolve) => { fixture.close(() => { resolve(); }); });
  }
  fixtures = [];
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // Best effort cleanup.
    }
  }
  handles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-providers-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(path.join(workspace, "proj espaço"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "file.txt"), "x");
  const opened = openLatticeDb(path.join(dir, "data"));
  handles.push(opened);
  claimOwnership(opened.raw);
  return { dir, workspace, db: opened.raw, tasks: new TaskManager(opened.raw, workspace) };
}

async function serve(db: unknown, workspace: string, dataDir?: string) {
  const assets = path.join(workspace, "..", "ui");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "index.html"), "<html></html>");
  const server = await serveLattice({
    db: db as import("node:sqlite").DatabaseSync,
    workspace,
    assetRoot: assets,
    ...(dataDir !== undefined ? { dataDir } : {}),
  });
  servers.push(server);
  return server;
}

async function authed(url: string) {
  const home = await fetch(`${url}/`);
  const cookie = home.headers.get("set-cookie")?.split(";")[0] ?? "";
  await home.arrayBuffer().catch(() => undefined);
  return cookie;
}

function postCommand(url: string, cookie: string, body: Record<string, unknown>) {
  return fetch(`${url}/api/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: url },
    body: JSON.stringify(body),
  });
}

/** Loopback OpenAI-compatible fixture: canned /models, records auth header. */
async function fixtureModels(models: unknown, status = 200): Promise<{ url: string; seenAuth: () => string | null }> {
  let seen: string | null = null;
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      seen = (request.headers["authorization"] as string) ?? null;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(models));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", () => { resolve(); }); });
  fixtures.push(server);
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, seenAuth: () => seen };
}

describe("provider presets on the core", () => {
  it("accepts known preset ids and rejects unknown providers", () => {
    const { tasks } = setup();
    for (const provider of ["openai", "openrouter", "gemini", "abacus", "local", "custom"]) {
      const created = tasks.handleCommand({
        commandId: `create-${provider}`,
        kind: "create-task",
        payload: { workspace: "", objective: "o", provider, model: "m", baseUrl: "http://127.0.0.1:9" },
      });
      expect(created.accepted).toBe(true);
    }
    const denied = tasks.handleCommand({
      commandId: "create-nope",
      kind: "create-task",
      payload: { workspace: "", objective: "o", provider: "nope", model: "m", baseUrl: null },
    });
    expect(denied.accepted).toBe(false);
  });

  it("scopes in-memory keys per preset with presence-only reads", () => {
    const { tasks } = setup();
    expect(tasks.keyConfigured("gemini")).toBe(false);
    tasks.setKey("gemini", "k1");
    expect(tasks.keyConfigured("gemini")).toBe(true);
    expect(tasks.keyConfigured("openai")).toBe(false);
    expect(() => tasks.setKey("nope", "k")).toThrow();
    expect(tasks.removeKey("gemini")).toBe(true);
    expect(tasks.keyConfigured("gemini")).toBe(false);
    expect(tasks.removeKey("gemini")).toBe(false);
  });

  it("reports key presence for the task provider in snapshots", () => {
    const { tasks } = setup();
    tasks.setKey("openrouter", "k");
    const created = tasks.handleCommand({
      commandId: "create-snap",
      kind: "create-task",
      payload: { workspace: "", objective: "o", provider: "openrouter", model: "m", baseUrl: "http://127.0.0.1:9" },
    });
    if (!created.accepted || created.taskId === "") throw new Error("create denied");
    expect(tasks.snapshot(created.taskId).keyConfigured).toBe(true);
  });

  it("lets keyless local switch models but requires custom endpoints", () => {
    const { tasks } = setup();
    const created = tasks.handleCommand({
      commandId: "create-local",
      kind: "create-task",
      payload: { workspace: "", objective: "o", provider: "local", model: "m", baseUrl: null },
    });
    if (!created.accepted || created.taskId === "") throw new Error("create denied");
    const switched = tasks.handleCommand({
      commandId: "switch-local",
      kind: "select-model",
      taskId: created.taskId,
      payload: { provider: "local", model: "m2", baseUrl: null },
    });
    expect(switched.accepted).toBe(true);
    const customBare = tasks.handleCommand({
      commandId: "switch-custom-bare",
      kind: "select-model",
      taskId: created.taskId,
      payload: { provider: "custom", model: "m2", baseUrl: null },
    });
    expect(customBare).toMatchObject({ accepted: false, reason: "invalid" });
    const customFull = tasks.handleCommand({
      commandId: "switch-custom-full",
      kind: "select-model",
      taskId: created.taskId,
      payload: { provider: "custom", model: "m2", baseUrl: "http://127.0.0.1:9/v1" },
    });
    expect(customFull.accepted).toBe(true);
    const createdBare = tasks.handleCommand({
      commandId: "create-custom-bare",
      kind: "create-task",
      payload: { workspace: "", objective: "o", provider: "custom", model: "m", baseUrl: null },
    });
    expect(createdBare).toMatchObject({ accepted: false, reason: "invalid" });
  });
});

describe("provider HTTP surfaces", () => {
  it("lists presets and key presence without ever exposing secrets", async () => {
    const { workspace, db } = setup();
    const server = await serve(db, workspace);
    const cookie = await authed(server.url);
    const setKey = await (await postCommand(server.url, cookie, {
      commandId: "k1",
      kind: "set-key",
      payload: { provider: "abacus", key: "super-secret-value" },
    })).json() as { accepted: boolean };
    expect(setKey.accepted).toBe(true);
    const presets = await (await fetch(`${server.url}/api/providers`, { headers: { Cookie: cookie } })).json() as {
      providers: Array<{ id: string; defaultBaseUrl: string }>;
    };
    expect(presets.providers.map((preset) => preset.id)).toEqual(["openai", "openrouter", "gemini", "abacus", "local"]);
    const status = await (await fetch(`${server.url}/api/providers/status`, { headers: { Cookie: cookie } })).json() as {
      status: Array<{ id: string; keyConfigured: boolean }>;
    };
    expect(status.status.find((entry) => entry.id === "abacus")).toEqual({ id: "abacus", keyConfigured: true });
    expect(status.status.find((entry) => entry.id === "openai")).toEqual({ id: "openai", keyConfigured: false });
    expect(JSON.stringify(status)).not.toContain("super-secret-value");
    expect(JSON.stringify(presets)).not.toContain("super-secret-value");
  });

  it("removes keys through an origin-checked endpoint", async () => {
    const { workspace, db } = setup();
    const server = await serve(db, workspace);
    const cookie = await authed(server.url);
    await postCommand(server.url, cookie, { commandId: "k2", kind: "set-key", payload: { provider: "gemini", key: "k" } });
    async function geminiConfigured(): Promise<boolean> {
      const status = await (await fetch(`${server.url}/api/providers/status`, { headers: { Cookie: cookie } })).json() as {
        status: Array<{ id: string; keyConfigured: boolean }>;
      };
      return status.status.find((entry) => entry.id === "gemini")?.keyConfigured === true;
    }
    expect(await geminiConfigured()).toBe(true);
    const foreign = await fetch(`${server.url}/api/providers/key?provider=gemini`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: "http://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect(await geminiConfigured()).toBe(true);
    const removed = await fetch(`${server.url}/api/providers/key?provider=gemini`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: server.url },
    });
    expect(await removed.json()).toMatchObject({ removed: true });
    expect(await geminiConfigured()).toBe(false);
    const bad = await fetch(`${server.url}/api/providers/key?provider=nope`, {
      method: "DELETE",
      headers: { Cookie: cookie, Origin: server.url },
    });
    expect(bad.status).toBe(400);
  });

  it("discovers models through the server key without leaking it", async () => {
    const { workspace, db } = setup();
    const fixture = await fixtureModels({ object: "list", data: [{ id: "m1" }, { id: "m2" }] });
    const server = await serve(db, workspace);
    const cookie = await authed(server.url);
    const listed = await (await fetch(`${server.url}/api/providers/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ providerId: "custom", baseUrl: fixture.url }),
    })).json() as { ok: boolean; models: Array<{ id: string }>; baseUrl: string };
    expect(listed.ok).toBe(true);
    expect(listed.models.map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(JSON.stringify(listed)).not.toContain("Authorization");

    await postCommand(server.url, cookie, { commandId: "k3", kind: "set-key", payload: { provider: "custom", key: "test-key" } });    await fetch(`${server.url}/api/providers/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ providerId: "custom", baseUrl: fixture.url }),
    });
    expect(fixture.seenAuth()).toBe("Bearer test-key");

    const tested = await (await fetch(`${server.url}/api/providers/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ providerId: "custom", baseUrl: fixture.url }),
    })).json() as { ok: boolean; kind: string; modelCount: number };
    expect(tested).toMatchObject({ ok: true, kind: "reachable", modelCount: 2 });

    const dead = await (await fetch(`${server.url}/api/providers/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ providerId: "custom", baseUrl: "http://127.0.0.1:9/v1" }),
    })).json() as { ok: boolean; kind: string };
    expect(dead.ok).toBe(false);
    expect(dead.kind).toBe("network");

    const unknown = await fetch(`${server.url}/api/providers/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ providerId: "nope" }),
    });
    expect(unknown.status).toBe(400);
    const credentialUrl = await fetch(`${server.url}/api/providers/models`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ providerId: "custom", baseUrl: "http://user:pass@127.0.0.1:9/v1" }),
    });
    expect(credentialUrl.status).toBe(400);
  });

  it("persists product config without secrets and reports unavailability honestly", async () => {
    const { dir, workspace, db } = setup();
    const dataDir = `${dir}-data`;
    const server = await serve(db, workspace, dataDir);
    const cookie = await authed(server.url);
    const initial = await (await fetch(`${server.url}/api/product-config`, { headers: { Cookie: cookie } })).json() as {
      config: { defaultProviderId: string };
    };
    expect(initial.config.defaultProviderId).toBe("openai");
    const saved = await fetch(`${server.url}/api/product-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ config: { schemaVersion: 1, defaultProviderId: "local", defaultModel: "m", defaultBaseUrl: null, customProviders: [] } }),
    });
    expect(saved.status).toBe(200);
    const reloaded = await (await fetch(`${server.url}/api/product-config`, { headers: { Cookie: cookie } })).json() as {
      config: { defaultProviderId: string; defaultModel: string };
    };
    expect(reloaded.config).toMatchObject({ defaultProviderId: "local", defaultModel: "m" });
    const sneaky = await fetch(`${server.url}/api/product-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ config: { schemaVersion: 1, apiKey: "sk-live" } }),
    });
    expect(sneaky.status).toBe(400);

    const plain = await serve(db, workspace);
    const plainCookie = await authed(plain.url);
    const unavailable = await fetch(`${plain.url}/api/product-config`, { headers: { Cookie: plainCookie } });
    expect(unavailable.status).toBe(503);
  });
});

describe("mediated workspace picker", () => {
  it("keeps lexical workspace strings when the server root passes through a link", async () => {
    const { dir, db } = setup();
    const real = path.join(dir, "ws");
    const alias = path.join(dir, "alias-ws");
    try {
      fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      console.warn("symlinks unavailable; linked-root test skipped");
      return;
    }
    const server = await serve(db, alias);
    const cookie = await authed(server.url);
    const info = await (await fetch(`${server.url}/api/info`, { headers: { Cookie: cookie } })).json() as { workspace: string };
    expect(info.workspace).toBe(alias);
    const body = await (await fetch(`${server.url}/api/workspace/browse?path=`, { headers: { Cookie: cookie } })).json() as {
      entries: Array<{ name: string }>;
    };
    expect(body.entries.map((entry) => entry.name)).toContain("proj espaço");
    const resolved = await (await fetch(`${server.url}/api/workspace/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ path: "proj espaço" }),
    })).json() as { path: string };
    expect(resolved.path).toBe(path.join(alias, "proj espaço"));
  });

  it("browses child directories without recursion or dotfiles", async () => {
    const { workspace, db } = setup();
    const server = await serve(db, workspace);
    const cookie = await authed(server.url);
    const body = await (await fetch(`${server.url}/api/workspace/browse?path=`, { headers: { Cookie: cookie } })).json() as {
      entries: Array<{ name: string; path: string }>;
    };
    expect(body.entries).toEqual([{ name: "proj espaço", path: path.join(workspace, "proj espaço") }]);
    const nested = await (await fetch(
      `${server.url}/api/workspace/browse?path=${encodeURIComponent("proj espaço")}`,
      { headers: { Cookie: cookie } },
    )).json() as { entries: unknown[] };
    expect(nested.entries).toEqual([]);
  });

  it("rejects escapes and resolves valid paths canonically", async () => {
    const { workspace, db } = setup();
    const server = await serve(db, workspace);
    const cookie = await authed(server.url);
    for (const bad of ["..", "../..", "/etc", ""]) {
      const response = await fetch(`${server.url}/api/workspace/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
        body: JSON.stringify({ path: bad }),
      });
      expect(response.status).toBe(400);
    }
    const resolved = await (await fetch(`${server.url}/api/workspace/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: server.url },
      body: JSON.stringify({ path: "proj espaço" }),
    })).json() as { path: string; displayName: string };
    expect(resolved).toMatchObject({ path: path.join(workspace, "proj espaço"), displayName: "proj espaço" });
  });
});
