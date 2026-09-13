import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ToolDefinition } from "../providers/types.js";
import { resolveInScope } from "../platform/paths.js";
import { HandleRegistry } from "./handles.js";
import { toolFailure, type Tool, type ToolContext, type ToolResult } from "./types.js";

export interface ReadArgs {
  path: string;
  start?: number;
  count?: number;
  handleId?: string;
}

export const READ_DEFINITION: ToolDefinition = {
  name: "read",
  description:
    "Read a workspace file by 1-based line range, or expand a previous truncated result via its handle. Returns a content version with every snapshot.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      start: { type: "number", description: "First line, 1-based, inclusive" },
      count: { type: "number", description: "Number of lines" },
      handleId: { type: "string", description: "Expand a previous truncated result" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const DEFAULT_COUNT = 200;
const MAX_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024;

export function contentVersion(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

export class ReadTool implements Tool<ReadArgs> {
  readonly definition = READ_DEFINITION;
  private readonly handles: HandleRegistry;
  constructor(handles: HandleRegistry = new HandleRegistry()) {
    this.handles = handles;
  }

  execute(rawArgs: ReadArgs, context: ToolContext): Promise<ToolResult> {
    return Promise.resolve(this.executeSync(rawArgs, context));
  }

  private executeSync(rawArgs: ReadArgs, context: ToolContext): ToolResult {
    if (typeof rawArgs.path !== "string" || rawArgs.path === "") {
      return toolFailure("invalid-args", "read path must be a non-empty string", false);
    }
    if (rawArgs.handleId !== undefined) {
      const handle = this.handles.get(rawArgs.handleId);
      if (handle === undefined) {
        return toolFailure("invalid-args", `unknown handle ${rawArgs.handleId}`, false);
      }
      return {
        status: "completed",
        summary: `expanded ${handle.kind} result ${handle.id}`,
        detail: handle.expand(),
        complete: true,
      };
    }
    const start = rawArgs.start ?? 1;
    const count = rawArgs.count ?? DEFAULT_COUNT;
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1) {
      return toolFailure("invalid-args", "start and count must be positive integers (start is 1-based)", false);
    }
    const absolute = resolveInScope(context.workspaceRoot, rawArgs.path);
    if (absolute === null) {
      return toolFailure("invalid-args", "read path escapes the workspace", false);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return toolFailure("not-found", `file not found: ${rawArgs.path}`, false);
    }
    if (!stat.isFile()) {
      return toolFailure("invalid-args", `not a file: ${rawArgs.path}`, false);
    }
    let buffer: Buffer;
    try {
      buffer = fs.readFileSync(absolute);
    } catch (error) {
      return toolFailure("unreadable", `cannot read ${rawArgs.path}: ${error instanceof Error ? error.message : "unknown error"}`, true);
    }
    const version = contentVersion(buffer);
    if (buffer.length === 0) {
      return {
        status: "completed",
        summary: `empty file ${rawArgs.path}`,
        detail: "",
        version,
        complete: true,
      };
    }
    if (buffer.includes(0)) {
      return {
        status: "completed",
        summary: `binary file ${rawArgs.path} (${stat.size} bytes); content not rendered`,
        version,
        complete: true,
      };
    }
    let text: string;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      text = buffer.toString("utf8");
    } catch {
      return {
        status: "completed",
        summary: `non-UTF8 file ${rawArgs.path}; content not rendered`,
        version,
        complete: true,
      };
    }
    const lines = text.split("\n");
    const totalLines = lines.length;
    if (start > totalLines) {
      return toolFailure("invalid-args", `start line ${start} beyond ${totalLines} total lines`, false);
    }
    const selected = lines.slice(start - 1, start - 1 + count);
    const omittedLines = totalLines - (start - 1 + selected.length);
    let rendered = selected
      .map((line, index) => {
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          const bytes = Buffer.from(line, "utf8").subarray(0, MAX_LINE_BYTES).toString("utf8");
          return `${start + index}:[line truncated at ${MAX_LINE_BYTES} bytes]${bytes}`;
        }
        return `${start + index}:${line}`;
      })
      .join("\n");
    let omittedBytes = 0;
    if (Buffer.byteLength(rendered, "utf8") > MAX_BYTES) {
      const full = rendered;
      rendered = Buffer.from(full, "utf8").subarray(0, MAX_BYTES).toString("utf8");
      omittedBytes = Buffer.byteLength(full, "utf8") - MAX_BYTES;
    }
    if (omittedLines <= 0 && omittedBytes <= 0) {
      return {
        status: "completed",
        summary: `${rawArgs.path} lines ${start}-${start + selected.length - 1} of ${totalLines}`,
        detail: rendered,
        version,
        complete: true,
      };
    }
    const note = `omitted ${omittedLines} trailing line(s)${omittedBytes > 0 ? ` and ~${omittedBytes} bytes` : ""}; expand via handle`;
    const handleId = this.handles.store("read", `${rawArgs.path}@${version} (${note})`, () => {
      const rest = lines.slice(start - 1 + count).join("\n");
      return `${rendered}\n[...]\n${rest}`;
    });
    return {
      status: "completed",
      summary: `${rawArgs.path} lines ${start}-${start + selected.length - 1} of ${totalLines}; ${note}`,
      detail: rendered,
      version,
      complete: false,
      truncated: true,
      truncationNote: note,
      handleId,
    };
  }
}
