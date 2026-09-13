import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkHost,
  checkOrigin,
  createSessionStore,
  sessionCookieHeader,
  type SessionStore,
} from "./auth.js";
import { PROTOCOL_VERSION, type UiCommand } from "./protocol.js";
import { TaskManager } from "./tasks.js";
import { findPreset, isKnownProviderId, listPresets } from "../providers/presets.js";
import { listModels, testConnection } from "../providers/discovery.js";
import { loadProductConfig, parseProductConfig, saveProductConfig } from "../productConfig.js";

const MAX_COMMAND_BYTES = 64 * 1024;
const HEARTBEAT_MS = 25_000;

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

/** Reject non-http(s) URLs and any URL embedding credentials. */
function isSafeEndpointUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return parsed.username === "" && parsed.password === "";
}

export interface LatticeServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export interface ServeOptions {
  db: import("node:sqlite").DatabaseSync;
  workspace: string;
  port?: number;
  assetRoot?: string;
  /** Device-global product config directory. Absent: config endpoints answer 503. */
  dataDir?: string;
}

function defaultAssetRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "ui");
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_COMMAND_BYTES) {
        reject(new Error("command body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", (error: Error) => {
      reject(error);
    });
  });
}

function parseCommand(body: string): UiCommand {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (typeof parsed.commandId !== "string" || parsed.commandId === "") {
    throw new Error("commandId is required");
  }
  const kinds = ["create-task", "start-task", "steer", "stop", "select-model", "set-key", "resume-task", "wake"];
  if (typeof parsed.kind !== "string" || !kinds.includes(parsed.kind)) {
    throw new Error("unknown command kind");
  }
  const command: UiCommand = {
    commandId: parsed.commandId,
    kind: parsed.kind as UiCommand["kind"],
  };
  if (parsed.taskId !== undefined) {
    if (typeof parsed.taskId !== "string") throw new Error("taskId must be a string");
    command.taskId = parsed.taskId;
  }
  if (parsed.expectedRevision !== undefined) {
    if (typeof parsed.expectedRevision !== "number") throw new Error("expectedRevision must be a number");
    command.expectedRevision = parsed.expectedRevision;
  }
  if (parsed.payload !== undefined) {
    if (typeof parsed.payload !== "object" || parsed.payload === null) {
      throw new Error("payload must be an object");
    }
    command.payload = parsed.payload as Record<string, unknown>;
  }
  return command;
}

export async function serveLattice(options: ServeOptions): Promise<LatticeServer> {
  const sessions: SessionStore = createSessionStore();
  const tasks = new TaskManager(options.db, options.workspace, undefined, options.dataDir ?? null);
  const assetRoot = options.assetRoot ?? defaultAssetRoot();
  const streams = new Set<http.ServerResponse>();

  const server = http.createServer((request, response) => {
    void handle(request, response, sessions, tasks, assetRoot, streams).catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "application/json" });
      }
      try {
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown error" }));
      } catch {
        // Response already gone; nothing left to do.
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (address !== null && typeof address === "object") resolve(address.port);
      else reject(new Error("could not determine loopback port"));
    });
  });
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const stream of streams) {
          try {
            stream.destroy();
          } catch {
            // Already gone.
          }
        }
        streams.clear();
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
      }),
  };
}

async function handle(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  sessions: SessionStore,
  tasks: TaskManager,
  assetRoot: string,
  streams: Set<http.ServerResponse>,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (!checkHost(request.headers.host)) {
    response.writeHead(400, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "unexpected Host" }));
    return;
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    const hasSession = sessions.check(request.headers.cookie);
    const headers: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
    if (!hasSession) {
      headers["Set-Cookie"] = sessionCookieHeader(sessions.issue());
    }
    response.writeHead(200, headers);
    response.end(await fs.promises.readFile(path.join(assetRoot, "index.html"), "utf8"));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    const filePath = path.normalize(path.join(assetRoot, url.pathname.slice("/assets/".length)));
    if (!filePath.startsWith(`${path.resolve(assetRoot)}${path.sep}`) && filePath !== path.resolve(assetRoot)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid asset path" }));
      return;
    }
    try {
      const body = await fs.promises.readFile(filePath);
      response.writeHead(200, { "Content-Type": contentType(filePath) });
      response.end(body);
    } catch {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not found" }));
    }
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
    return;
  }
  if (!sessions.check(request.headers.cookie)) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "missing or invalid session" }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ protocol: PROTOCOL_VERSION, sessions: tasks.listSessions() }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/info") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ protocol: PROTOCOL_VERSION, workspace: tasks.serverWorkspace }));
    return;
  }

  // S5 product surfaces. Session cookie required (checked above); state
  // changes additionally require a loopback origin, like /api/commands.
  // Secrets never leave the server: status and discovery answers carry
  // presence and metadata only.
  if (request.method === "GET" && url.pathname === "/api/providers") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ protocol: PROTOCOL_VERSION, providers: listPresets() }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/providers/status") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      protocol: PROTOCOL_VERSION,
      status: [...listPresets().map((preset) => preset.id), "custom"].map((id) => ({
        id,
        keyConfigured: tasks.keyConfigured(id),
      })),
    }));
    return;
  }

  if (request.method === "DELETE" && url.pathname === "/api/providers/key") {
    if (!checkOrigin(request.headers.origin)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "foreign origin rejected" }));
      return;
    }
    const providerId = url.searchParams.get("provider") ?? "";
    try {
      const removed = tasks.removeKey(providerId);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ protocol: PROTOCOL_VERSION, removed }));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid provider" }));
    }
    return;
  }

  if (request.method === "POST" && (url.pathname === "/api/providers/models" || url.pathname === "/api/providers/test")) {
    if (!checkOrigin(request.headers.origin)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "foreign origin rejected" }));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    const providerId = typeof body["providerId"] === "string" ? body["providerId"] : "";
    const baseUrl = typeof body["baseUrl"] === "string" && body["baseUrl"].trim() !== "" ? body["baseUrl"] : null;
    const preset = providerId === "custom" ? null : findPreset(providerId);
    if (!isKnownProviderId(providerId)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unknown provider preset" }));
      return;
    }
    const effectiveBase = baseUrl ?? preset?.defaultBaseUrl ?? null;
    if (effectiveBase === null || !isSafeEndpointUrl(effectiveBase)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "custom providers need a valid http(s) base URL without credentials" }));
      return;
    }
    let apiKey = "";
    try {
      apiKey = tasks.providerApiKey(providerId);
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unknown provider preset" }));
      return;
    }
    if (url.pathname === "/api/providers/test") {
      const result = await testConnection({ baseUrl: effectiveBase, apiKey });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ protocol: PROTOCOL_VERSION, providerId, baseUrl: effectiveBase, ...result }));
      return;
    }
    const result = await listModels({ baseUrl: effectiveBase, apiKey });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ protocol: PROTOCOL_VERSION, providerId, baseUrl: effectiveBase, ...result }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/product-config") {
    if (tasks.dataDir === null) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "product config is unavailable on this server" }));
      return;
    }
    let payload: string;
    try {
      payload = JSON.stringify({ protocol: PROTOCOL_VERSION, config: loadProductConfig(tasks.dataDir) });
    } catch (error) {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "cannot load product config" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(payload);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/product-config") {
    if (!checkOrigin(request.headers.origin)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "foreign origin rejected" }));
      return;
    }
    if (tasks.dataDir === null) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "product config is unavailable on this server" }));
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request)) as unknown;
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    try {
      const config = parseProductConfig(JSON.stringify((body as Record<string, unknown>)["config"] ?? null));
      saveProductConfig(tasks.dataDir, config);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ protocol: PROTOCOL_VERSION, config }));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid product config" }));
    }
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/workspace/browse") {
    const rel = url.searchParams.get("path") ?? "";
    let payload: string;
    try {
      payload = JSON.stringify({ protocol: PROTOCOL_VERSION, entries: tasks.browseWorkspace(rel) });
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "cannot browse workspace" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(payload);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/workspace/resolve") {
    if (!checkOrigin(request.headers.origin)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "foreign origin rejected" }));
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    } catch {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "invalid JSON body" }));
      return;
    }
    const requested = typeof body["path"] === "string" ? body["path"] : "";
    let payload: string;
    try {
      payload = JSON.stringify({ protocol: PROTOCOL_VERSION, ...tasks.resolveWorkspacePath(requested) });
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid workspace path" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(payload);
    return;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)\/(snapshot|events|tool)$/.exec(url.pathname);
  if (request.method === "GET" && taskMatch?.[1] !== undefined && taskMatch[2] !== undefined) {
    const taskId = decodeURIComponent(taskMatch[1]);
    if (taskMatch[2] === "snapshot") {
      let body: string;
      try {
        body = JSON.stringify(tasks.snapshot(taskId));
      } catch (error) {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown task" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(body);
      return;
    }
    if (taskMatch[2] === "events") {
      streams.add(response);
      try {
        streamEvents(request, response, tasks, taskId);
      } finally {
        response.once("close", () => {
          streams.delete(response);
        });
      }
      return;
    }
    const toolId = url.searchParams.get("id") ?? "";
    let toolBody: string;
    try {
      toolBody = JSON.stringify(tasks.toolDetail(taskId, toolId));
    } catch (error) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "unknown tool" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(toolBody);
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/commands") {
    if (!checkOrigin(request.headers.origin)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "foreign origin rejected" }));
      return;
    }
    let command: UiCommand;
    try {
      command = parseCommand(await readBody(request));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "invalid command" }));
      return;
    }
    const result = tasks.handleCommand(command);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
    return;
  }

  response.writeHead(404, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: "not found" }));
}

function streamEvents(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  tasks: TaskManager,
  taskId: string,
): void {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (id: number, data: string): boolean => {
    try {
      return response.write(`id: ${id}\ndata: ${data}\n\n`);
    } catch {
      return false;
    }
  };
  const lastId = Number.parseInt(
    (Array.isArray(request.headers["last-event-id"]) ? request.headers["last-event-id"][0] : request.headers["last-event-id"]) ?? "0",
    10,
  );
  const after = Number.isInteger(lastId) ? lastId : 0;
  const missed = tasks.missedEvents(taskId, after);
  if (missed.resync) {
    send(after, JSON.stringify({ seq: after, kind: "resync", cut: after }));
  } else {
    for (const event of missed.events) send(event.seq, JSON.stringify(event));
  }
  const heartbeat = setInterval(() => {
    try {
      response.write(": heartbeat\n\n");
    } catch {
      // Client gone; the close handler below cleans up.
    }
  }, HEARTBEAT_MS);
  const closer = (): void => {
    clearInterval(heartbeat);
    tasks.unsubscribe(taskId, subscriber);
  };
  const subscriber = (event: import("./protocol.js").UiEvent): void => {
    if (!send(event.seq, JSON.stringify(event))) {
      closer();
      return;
    }
    if (response.writableLength > 256 * 1024) {
      send(event.seq, JSON.stringify({ seq: event.seq, kind: "resync", cut: event.seq }));
      closer();
    }
  };
  tasks.subscribe(taskId, subscriber);
  request.once("close", closer);
}
