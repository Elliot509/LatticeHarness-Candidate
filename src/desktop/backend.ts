// P0 desktop backend entry: opens the existing Lattice database, claims
// single-process ownership and serves the existing HTTP/SSE UI. The packaged
// Electron utility process loads THIS module; HTTP/SSE remain the renderer
// transport. No task/runtime/database logic lives here beyond startup.
import { claimOwnership, openLatticeDb } from "../storage/db.js";
import { checkRuntimeVersion } from "../platform/runtime.js";
import type { TaskManager } from "../server/tasks.js";
import type { LatticeServer } from "../server/server.js";
import type { LatticeDb } from "../storage/db.js";

import { DESKTOP_BACKEND_PROTOCOL } from "./protocol.js";
export { DESKTOP_BACKEND_PROTOCOL } from "./protocol.js";

export interface DesktopBackendConfig {
  workspace: string;
  dataDir: string;
  port?: number;
  nativeProjectSelection?: boolean;
}

interface BackendStartRequest {
  id: number;
  op: "start";
  config: DesktopBackendConfig;
}

interface BackendStopRequest {
  id: number;
  op: "stop";
}

interface BackendCommandRequest {
  id: number;
  op: "command";
  command: {
    commandId: string;
    kind: string;
    taskId?: string;
    payload?: Record<string, unknown>;
  };
}

type BackendRequest = BackendStartRequest | BackendStopRequest | BackendCommandRequest | { id?: number; op: string };

function post(message: unknown): void {
  if (typeof process.send === "function") {
    process.send(message);
  } else {
    const parentPort = (process as unknown as { parentPort?: { postMessage(message: unknown): void } }).parentPort;
    parentPort?.postMessage(message);
  }
}

function fail(id: number | null, error: unknown): void {
  post({
    type: "lattice-backend-error",
    ...(id !== null ? { id } : {}),
    error: error instanceof Error ? error.message : String(error),
  });
}

export interface DesktopBackend {
  readonly tasks: TaskManager;
  readonly server: LatticeServer;
  readonly db: LatticeDb;
  close(): Promise<void>;
}

export async function startDesktopBackend(config: DesktopBackendConfig): Promise<DesktopBackend> {
  if (typeof config.workspace !== "string" || (config.workspace.trim() === "" && config.nativeProjectSelection !== true)) {
    throw new Error("backend start needs a workspace");
  }
  if (typeof config.dataDir !== "string" || config.dataDir.trim() === "") {
    throw new Error("backend start needs a dataDir");
  }
  checkRuntimeVersion();
  const db = openLatticeDb(config.dataDir);
  try {
    claimOwnership(db.raw);
  } catch (error) {
    db.close();
    throw error;
  }
  try {
    const { TaskManager } = await import("../server/tasks.js");
    const tasks = new TaskManager(db.raw, config.workspace, undefined, config.dataDir, config.nativeProjectSelection);
    const { serveLatticeWithManager } = await import("../server/server.js");
    const server = await serveLatticeWithManager({
      db: db.raw,
      workspace: config.workspace,
      tasks,
      privateBootstrap: true,
      ...(config.port !== undefined ? { port: config.port } : {}),
    });
    let closing: Promise<void> | null = null;
    return {
      tasks,
      server,
      db,
      close: () => {
        closing ??= (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([tasks.close(), new Promise<never>((_, reject) => {
              timer = setTimeout(() => { reject(new Error("task drain timed out; pending effects require recovery")); }, 8000);
            })]);
          } finally { clearTimeout(timer); }
          await server.close();
          db.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function installBackendChannel(start: typeof startDesktopBackend = startDesktopBackend): () => Promise<void> {
  let backend: DesktopBackend | null = null;
  const onMessage = async (raw: unknown): Promise<void> => {
    const message = raw as BackendRequest | null;
    if (message === null || typeof message !== "object" || typeof (message as { op?: unknown }).op !== "string") return;
    const op = (message as { op: string }).op;
    if (op === "start") {
      const request = message as BackendStartRequest;
      if (backend !== null) {
        fail(typeof request.id === "number" ? request.id : null, new Error("backend already started"));
        return;
      }
      try {
        backend = await start(request.config);
        post({
          type: "lattice-backend-ready",
          id: request.id,
          protocol: DESKTOP_BACKEND_PROTOCOL,
          url: backend.server.url,
          port: backend.server.port,
          bootstrapCookie: backend.server.bootstrapCookie,
        });
      } catch (error) {
        fail(typeof request.id === "number" ? request.id : null, error);
      }
      return;
    }
    if (op === "stop") {
      const request = message as BackendStopRequest;
      try {
        await backend?.close();
      } catch {
        fail(request.id, new Error("backend drain failed; shutdown is not confirmed"));
        return;
      }
      backend = null;
      post({ type: "lattice-backend-stopped", id: request.id });
      return;
    }
    if (op === "select-workspace") {
      try {
        const selected = (message as unknown as { workspace: unknown }).workspace;
        if (backend === null || typeof selected !== "string" || selected.trim() === "") throw new Error("invalid project selection");
        const workspace = backend.tasks.selectNativeWorkspace(selected);
        post({ type: "lattice-workspace-selected", id: message.id, workspace });
      } catch (error) { fail(message.id ?? null, error); }
      return;
    }
    if (op === "status") {
      post({ type: "lattice-backend-status", id: message.id, activeTasks: backend?.tasks.activeTaskCount ?? 0 });
      return;
    }
    if (op === "command") {
      const request = message as BackendCommandRequest;
      if (backend === null) {
        fail(typeof request.id === "number" ? request.id : null, new Error("backend not started"));
        return;
      }
      try {
        const result = backend.tasks.handleCommand(
          request.command as Parameters<TaskManager["handleCommand"]>[0],
        );
        post({ type: "lattice-backend-result", id: request.id, result });
      } catch (error) {
        fail(typeof request.id === "number" ? request.id : null, error);
      }
      return;
    }
    const id = (message as { id?: unknown }).id;
    fail(typeof id === "number" ? id : null, new Error(`unknown backend op ${op}`));
  };
  const parentPort = (process as unknown as { parentPort?: { on(event: string, listener: (event: { data?: unknown }) => void): void } }).parentPort;
  if (parentPort !== undefined) {
    parentPort.on("message", (event: { data?: unknown }) => {
      void onMessage(event.data ?? event);
    });
  } else {
    process.on("message", (message: unknown) => {
      void onMessage(message);
    });
  }
  post({ type: "lattice-backend-hello", protocol: DESKTOP_BACKEND_PROTOCOL });
  return async () => {
    await backend?.close();
    backend = null;
  };
}
