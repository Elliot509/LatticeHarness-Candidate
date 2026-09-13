import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../providers/types.js";
import { resolveInScope } from "../platform/paths.js";
import { HandleRegistry } from "./handles.js";
import { toolFailure, type Tool, type ToolContext, type ToolResult } from "./types.js";

export interface SearchArgs {
  kind: "path" | "text";
  query: string;
  root?: string;
  maxMatches?: number;
  maxFiles?: number;
}

export const SEARCH_DEFINITION: ToolDefinition = {
  name: "search",
  description:
    "Literal path or text search confined to the workspace. Reports scope, limits and completeness; a truncated result never proves global absence.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["path", "text"] },
      query: { type: "string", description: "Literal substring, not a regex" },
      root: { type: "string", description: "Subdirectory relative to the workspace root" },
      maxMatches: { type: "number" },
      maxFiles: { type: "number" },
    },
    required: ["kind", "query"],
    additionalProperties: false,
  },
};

const DEFAULT_MAX_MATCHES = 50;
const DEFAULT_MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", ".hg", ".svn", "target"]);

interface Match {
  file: string;
  line: number;
  text: string;
}

function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0);
}

function* walkFiles(root: string, errors: string[]): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    errors.push(`cannot list ${root}: ${error instanceof Error ? error.message : "unknown error"}`);
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) yield* walkFiles(full, errors);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

export class SearchTool implements Tool<SearchArgs> {
  readonly definition = SEARCH_DEFINITION;
  private readonly handles: HandleRegistry;
  constructor(handles: HandleRegistry = new HandleRegistry()) {
    this.handles = handles;
  }

  execute(rawArgs: SearchArgs, context: ToolContext): Promise<ToolResult> {
    return Promise.resolve(this.executeSync(rawArgs, context));
  }

  private executeSync(rawArgs: SearchArgs, context: ToolContext): ToolResult {
    const kind: unknown = rawArgs.kind;
    if (kind !== "path" && kind !== "text") {
      return toolFailure("invalid-args", "search kind must be path or text", false);
    }
    if (typeof rawArgs.query !== "string" || rawArgs.query === "") {
      return toolFailure("invalid-args", "search query must be a non-empty literal", false);
    }
    const maxMatches =
      rawArgs.maxMatches ?? DEFAULT_MAX_MATCHES;
    const maxFiles = rawArgs.maxFiles ?? DEFAULT_MAX_FILES;
    if (!Number.isInteger(maxMatches) || maxMatches <= 0 || !Number.isInteger(maxFiles) || maxFiles <= 0) {
      return toolFailure("invalid-args", "maxMatches and maxFiles must be positive integers", false);
    }
    const scopeRoot = resolveInScope(context.workspaceRoot, rawArgs.root ?? ".");
    if (scopeRoot === null) {
      return toolFailure("invalid-args", "search root escapes the workspace", false);
    }

    const errors: string[] = [];
    const matches: Match[] = [];
    let filesScanned = 0;
    let filesSkipped = 0;
    let complete = true;

    for (const file of walkFiles(scopeRoot, errors)) {
      if (filesScanned >= maxFiles) {
        complete = false;
        break;
      }
      filesScanned += 1;
      const relative = path.relative(scopeRoot, file);
      if (rawArgs.kind === "path") {
        if (relative.includes(rawArgs.query)) {
          matches.push({ file: relative, line: 0, text: relative });
          if (matches.length >= maxMatches) {
            complete = false;
            break;
          }
        }
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.statSync(file);
      } catch {
        filesSkipped += 1;
        continue;
      }
      if (stat.size > MAX_FILE_BYTES) {
        filesSkipped += 1;
        continue;
      }
      let buffer: Buffer;
      try {
        buffer = fs.readFileSync(file);
      } catch (error) {
        errors.push(`cannot read ${relative}: ${error instanceof Error ? error.message : "unknown error"}`);
        continue;
      }
      if (isBinary(buffer)) {
        filesSkipped += 1;
        continue;
      }
      const text = buffer.toString("utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line !== undefined && line.includes(rawArgs.query)) {
          matches.push({ file: relative, line: i + 1, text: line.slice(0, 300) });
          if (matches.length >= maxMatches) {
            complete = false;
            break;
          }
        }
      }
      if (!complete) break;
    }

    const scopeNote = `scope ${path.relative(context.workspaceRoot, scopeRoot) === "" ? "." : path.relative(context.workspaceRoot, scopeRoot)}, ${filesScanned} files read, ${filesSkipped} skipped (binary/oversize/unreadable), ignored: ${[...IGNORED_DIRS].join(",")}`;
    const errorNote = errors.length > 0 ? ` errors: ${errors.join(" | ")}` : "";
    if (complete) {
      return {
        status: "completed",
        summary: `${matches.length} match(es). ${scopeNote}.${errorNote}`,
        detail: matches.map((m) => `${m.file}:${m.line}:${m.text}`).join("\n"),
        complete: true,
      };
    }
    const full = matches.map((m) => `${m.file}:${m.line}:${m.text}`).join("\n");
    const handleId = this.handles.store("search", `${matches.length}+ matches (truncated)`, () => full);
    return {
      status: "completed",
      summary: `at least ${matches.length} match(es), search incomplete (limit reached). ${scopeNote}.${errorNote} Absence in this preview proves nothing global.`,
      detail: full,
      complete: false,
      truncated: true,
      truncationNote: "match or file limit reached; counts are lower bounds",
      handleId,
    };
  }
}
