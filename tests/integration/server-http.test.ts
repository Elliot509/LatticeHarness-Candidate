import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership, type LatticeDb } from "../../src/storage/db.js";
import { serveLattice, type LatticeServer } from "../../src/server/server.js";

let dirs: string[] = [];
let handles: LatticeDb[] = [];
let servers: LatticeServer[] = [];
afterEach(async () => {
  for (const server of servers) {
    try {
      await server.close();
    } catch {
      // Best effort cleanup.
    }
  }
  servers = [];
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

async function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-http-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const assets = path.join(dir, "ui");
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, "index.html"), "<html><body>lattice</body></html>");
  const opened = openLatticeDb(path.join(dir, "data"));
  handles.push(opened);
  claimOwnership(opened.raw);
  const server = await serveLattice({ db: opened.raw, workspace, assetRoot: assets });
  servers.push(server);
  const home = await fetch(`${server.url}/`);
  const cookie = home.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { server, cookie, workspace };
}

function rawStatus(port: number, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET /api/sessions HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
    });
    socket.on("close", () => {
      const head = data.slice(0, data.indexOf("\r\n\r\n"));
      const status = Number.parseInt(head.split(" ")[1] ?? "0", 10);
      resolve({ status, body: data.slice(data.indexOf("\r\n\r\n") + 4) });
    });
    socket.on("error", (error: Error) => reject(error));
  });
}

function post(url: string, cookie: string, body: Record<string, unknown>, origin?: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      ...(origin !== undefined ? { Origin: origin } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("server http boundary", () => {
  it("serves the app and requires a session for the api", async () => {
    const { server, cookie } = await serve();
    const home = await fetch(`${server.url}/`);
    expect(home.status).toBe(200);
    const denied = await fetch(`${server.url}/api/sessions`);
    expect(denied.status).toBe(401);
    const allowed = await fetch(`${server.url}/api/sessions`, { headers: { Cookie: cookie } });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { protocol: string; sessions: unknown[] };
    expect(body.protocol).toBe("ui-1");
    expect(body.sessions).toEqual([]);
  });

  it("rejects hostile hosts and foreign origins", async () => {
    const { server, cookie } = await serve();
    const badHost = await rawStatus(server.port, "evil.example");
    expect(badHost.status).toBe(400);
    const goodHost = await rawStatus(server.port, "127.0.0.1");
    expect(goodHost.status).toBe(401);
    const badOrigin = await post(`${server.url}/api/commands`, cookie, { commandId: "x", kind: "stop" }, "https://evil.example");
    expect(badOrigin.status).toBe(403);
    const badCommand = await post(`${server.url}/api/commands`, cookie, { nope: true });
    expect(badCommand.status).toBe(400);
  });

  it("creates a task over http and snapshots it", async () => {
    const { server, cookie, workspace } = await serve();
    const created = await post(`${server.url}/api/commands`, cookie, {
      commandId: "http-create",
      kind: "create-task",
      payload: { workspace: "", objective: "Fix it", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as { accepted: boolean; taskId: string };
    expect(createdBody.accepted).toBe(true);
    const snapshot = await fetch(`${server.url}/api/tasks/${createdBody.taskId}/snapshot`, {
      headers: { Cookie: cookie },
    });
    expect(snapshot.status).toBe(200);
    const snap = (await snapshot.json()) as { objective: string; state: string; workspace: string };
    expect(snap.objective).toBe("Fix it");
    expect(snap.state).toBe("READY");
    expect(snap.workspace).toBe(workspace);
    const missing = await fetch(`${server.url}/api/tasks/task-nope/snapshot`, {
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);
  });

  it("never serves files outside the asset root and rejects command GETs", async () => {
    const { server, cookie } = await serve();
    for (const target of ["/assets/../package.json", "/assets/..%2fpackage.json", "/api/commands"]) {
      const response = await fetch(`${server.url}${target}`, { headers: { Cookie: cookie } });
      expect([400, 404]).toContain(response.status);
      if (target !== "/api/commands") {
        expect(await response.text()).not.toContain("lattice-harness");
      }
    }
  });
  it("streams events to subscribers", async () => {
    const { server, cookie } = await serve();
    const created = await post(`${server.url}/api/commands`, cookie, {
      commandId: "http-stream",
      kind: "create-task",
      payload: { workspace: "", objective: "Fix it", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
    });
    const { taskId } = (await created.json()) as { taskId: string };
    const stream = await fetch(`${server.url}/api/tasks/${taskId}/events`, {
      headers: { Cookie: cookie, Accept: "text/event-stream" },
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body?.getReader();
    expect(reader).toBeDefined();
    if (reader === undefined) throw new Error("no stream body");
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 5000;
    while (!buffer.includes("data:") && Date.now() < deadline) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    await reader.cancel();
    expect(buffer).toContain("data:");
    expect(buffer).toContain("\"kind\"");
  });
});
