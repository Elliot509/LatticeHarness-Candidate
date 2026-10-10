import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { resolveInScope } from "../platform/paths.js";
import { toolFailure, type ToolContext, type ToolResult } from "./types.js";

export interface DirectoryArgs {
  path: string;
  recursive?: boolean;
  cursor?: string;
  pageSize?: number;
}

export interface DirectoryEntry { path: string; type: "directory" | "file" | "symlink" | "other" }
export interface DirectoryPage {
  snapshot: string;
  scope: string;
  recursive: boolean;
  entries: DirectoryEntry[];
  offset: number;
  nextOffset: number;
  total: number;
  scanComplete: boolean;
  errors: string[];
  nextCursor: string | null;
}
interface Snapshot {
  root: string;
  scope: string;
  recursive: boolean;
  entries: DirectoryEntry[];
  errors: string[];
  scanComplete: boolean;
  version: string;
}

const PAGE_CHARS = 2800;
const MAX_ENTRIES = 10_000;
const MAX_SNAPSHOT_CHARS = 2 * 1024 * 1024;

// Metadata only. Hidden/generated entries are included; links are listed but
// never traversed. Cursors address this bounded observation, not a live tree.
export class DirectoryReader {
  private readonly snapshots = new Map<string, Snapshot>();

  async execute(args: DirectoryArgs, context: ToolContext): Promise<ToolResult> {
    if (typeof args.path !== "string" || args.path === "" || (args.cursor !== undefined && typeof args.cursor !== "string")) return toolFailure("invalid-args", "directory path must be non-empty; cursor must be a string", false);
    const pageSize = args.pageSize ?? 50;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200
      || (args.recursive !== undefined && typeof args.recursive !== "boolean")) return toolFailure("invalid-args", "directory pageSize must be 1..200; recursive must be boolean", false);
    const root = resolveInScope(context.workspaceRoot, ".");
    const absolute = resolveInScope(context.workspaceRoot, args.path);
    if (root === null || absolute === null) return toolFailure("invalid-args", "directory path escapes workspace", false);
    const scope = path.relative(root, absolute) || ".";
    let id: string;
    let offset = 0;
    let snapshot: Snapshot;
    if (args.cursor !== undefined) {
      const match = /^([a-f0-9-]{36}):(\d+)$/u.exec(args.cursor);
      const found = match?.[1] === undefined ? undefined : this.snapshots.get(match[1]);
      if (found === undefined || found.root !== root || found.scope !== scope || found.recursive !== (args.recursive ?? false)) return toolFailure("stale-cursor", "directory cursor unavailable or belongs to a different scope; request a new snapshot", false);
      id = match?.[1] ?? "";
      offset = Number(match?.[2]);
      snapshot = found;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= snapshot.entries.length) return toolFailure("invalid-args", "directory cursor offset is invalid", false);
    } else {
      id = randomUUID();
      snapshot = { root, scope, recursive: args.recursive ?? false, entries: [], errors: [], scanComplete: true, version: "" };
      let chars = 0;
      const start = performance.now();
      const guard = (): void => {
        if (context.signal?.aborted === true) throw new Error("directory observation cancelled");
        if (performance.now() - start > Math.min(context.timeoutMs ?? 5000, 5000)) throw new Error("directory observation time limit reached");
        if (snapshot.entries.length >= MAX_ENTRIES || chars >= MAX_SNAPSHOT_CHARS) throw new Error("directory observation size limit reached");
      };
      const walk = async (dir: string): Promise<void> => {
        guard();
        const safe = resolveInScope(root, path.relative(root, dir) || ".");
        const before = await fs.promises.lstat(dir);
        if (safe !== dir || before.isSymbolicLink() || !before.isDirectory()) throw new Error("directory changed or is not a directory");
        const items = await fs.promises.readdir(dir, { withFileTypes: true });
        items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        for (const item of items) {
          guard();
          const full = path.join(dir, item.name);
          const entry: DirectoryEntry = { path: path.relative(root, full), type: item.isSymbolicLink() ? "symlink" : item.isDirectory() ? "directory" : item.isFile() ? "file" : "other" };
          chars += JSON.stringify(entry).length;
          snapshot.entries.push(entry);
          if (snapshot.recursive && item.isDirectory()) {
            try { await walk(full); }
            catch (error) { snapshot.scanComplete = false; snapshot.errors.push(`${entry.path}: ${error instanceof Error ? error.message : "unreadable directory"}`); }
          }
        }
        const after = await fs.promises.lstat(dir);
        if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs || resolveInScope(root, path.relative(root, dir) || ".") !== dir) throw new Error("directory changed during observation; completeness unknown");
      };
      try { await walk(absolute); }
      catch (error) { snapshot.scanComplete = false; snapshot.errors.push(error instanceof Error ? error.message : "unreadable directory"); }
      if (context.signal?.aborted === true) return { status: "cancelled", summary: "directory observation cancelled; no complete inventory", complete: false };
      snapshot.entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      snapshot.version = createHash("sha256").update(JSON.stringify([scope, snapshot.recursive, snapshot.entries, snapshot.scanComplete, snapshot.errors])).digest("hex");
      if (this.snapshots.size >= 8) this.snapshots.delete(this.snapshots.keys().next().value ?? "");
      this.snapshots.set(id, snapshot);
    }
    const entries: DirectoryEntry[] = [];
    let chars = 0;
    for (const entry of snapshot.entries.slice(offset, offset + pageSize)) {
      const size = JSON.stringify(entry).length + 2;
      if (chars + size > PAGE_CHARS) break;
      entries.push(entry); chars += size;
    }
    if (entries.length === 0 && snapshot.entries.length > offset) return toolFailure("entry-too-large", "directory entry exceeds the bounded page; completeness cannot be delivered", false);
    const nextOffset = offset + entries.length;
    const nextCursor = nextOffset < snapshot.entries.length ? `${id}:${nextOffset}` : null;
    const page: DirectoryPage = { snapshot: id, scope, recursive: snapshot.recursive, entries, offset, nextOffset, total: snapshot.entries.length, scanComplete: snapshot.scanComplete, errors: snapshot.errors.slice(0, 8), nextCursor };
    return {
      status: "completed",
      summary: `Directory ${JSON.stringify(scope)}; ${snapshot.recursive ? "recursive" : "immediate children"}; hidden included, no exclusions, symlinks not followed. Observed entries ${offset}-${nextOffset} of ${snapshot.entries.length}${snapshot.scanComplete ? "" : "+ (scan incomplete)"}; ${nextCursor === null ? "no further page" : `continue read kind=directory path=${JSON.stringify(args.path)} recursive=${snapshot.recursive} cursor=${nextCursor}`}`,
      detail: JSON.stringify(page), directoryPage: page,
      version: snapshot.version,
      observationKey: createHash("sha256").update(JSON.stringify([snapshot.version, entries])).digest("hex"),
      complete: snapshot.scanComplete && nextCursor === null,
      truncated: nextCursor !== null || !snapshot.scanComplete,
      truncationNote: "Coverage is the declared directory snapshot, not an atomic filesystem snapshot; retrieve nextCursor without rerunning the scan.",
      progress: { scope: `directory:${scope}:${snapshot.recursive}`, version: snapshot.version, items: entries.map(entry => JSON.stringify(entry)) },
    };
  }
}
