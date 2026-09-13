import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../providers/types.js";
import { resolveInScope } from "../platform/paths.js";
import { contentVersion } from "./read.js";
import { toolFailure, type Tool, type ToolContext, type ToolResult } from "./types.js";

export type EditOperation =
  | { kind: "create"; path: string; content: string }
  | { kind: "replace"; path: string; expectedVersion: string; oldText: string; newText: string }
  | { kind: "delete"; path: string; expectedVersion: string }
  | { kind: "rename"; path: string; expectedVersion: string; newPath: string };

export const EDIT_DEFINITION: ToolDefinition = {
  name: "edit",
  description:
    "Versioned literal file edit: create (target must be absent), replace (single literal match under the expected content version), delete, or rename. No fuzzy matching, no silent formatting.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["create", "replace", "delete", "rename"] },
      path: { type: "string" },
      content: { type: "string" },
      expectedVersion: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      newPath: { type: "string" },
    },
    required: ["kind", "path"],
    additionalProperties: false,
  },
};

const MAX_STORED_BYTES = 64 * 1024;

export interface EditPlan {
  operation: EditOperation;
  beforeVersion: string | null;
}

function resolveInWorkspace(workspaceRoot: string, target: string): string | null {
  return resolveInScope(workspaceRoot, target);
}

function storedPreview(content: Buffer): { hash: string; preview: string; truncated: boolean } {
  const hash = `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  if (content.length <= MAX_STORED_BYTES) {
    return { hash, preview: content.toString("utf8"), truncated: false };
  }
  return { hash, preview: content.subarray(0, MAX_STORED_BYTES).toString("utf8"), truncated: true };
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export class EditTool implements Tool<EditOperation> {
  readonly definition = EDIT_DEFINITION;

  execute(rawArgs: EditOperation, context: ToolContext): Promise<ToolResult> {
    return Promise.resolve(this.executeSync(rawArgs, context));
  }

  private executeSync(rawArgs: EditOperation, context: ToolContext): ToolResult {
    const absolute = resolveInWorkspace(context.workspaceRoot, rawArgs.path);
    if (absolute === null) {
      return toolFailure("invalid-args", "edit path escapes the workspace", false);
    }
    try {
      switch (rawArgs.kind) {
        case "create":
          return this.create(absolute, rawArgs);
        case "replace":
          return this.replace(absolute, rawArgs);
        case "delete":
          return this.delete(absolute, rawArgs);
        case "rename":
          return this.rename(absolute, rawArgs, context);
        default:
          return toolFailure("invalid-args", "unknown edit kind", false);
      }
    } catch (error) {
      return toolFailure(
        "io-error",
        `edit failed: ${error instanceof Error ? error.message : "unknown error"}`,
        true,
      );
    }
  }

  private create(absolute: string, args: Extract<EditOperation, { kind: "create" }>): ToolResult {
    if (typeof args.content !== "string") {
      return toolFailure("invalid-args", "create requires content", false);
    }
    if (fs.existsSync(absolute)) {
      return toolFailure("precondition", `create refused: ${args.path} already exists`, false);
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, args.content);
    const after = contentVersion(Buffer.from(args.content, "utf8"));
    return {
      status: "completed",
      summary: `created ${args.path}`,
      detail: JSON.stringify({ beforeVersion: null, afterVersion: after }),
      version: after,
      complete: true,
    };
  }

  private replace(absolute: string, args: Extract<EditOperation, { kind: "replace" }>): ToolResult {
    if (typeof args.oldText !== "string" || args.oldText === "" || typeof args.newText !== "string") {
      return toolFailure("invalid-args", "replace requires non-empty oldText and newText", false);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return toolFailure("not-found", `replace refused: ${args.path} does not exist`, false);
    }
    const before = fs.readFileSync(absolute);
    if (before.includes(0)) {
      return toolFailure("precondition", "replace refused: binary file", false);
    }
    const currentVersion = contentVersion(before);
    if (currentVersion !== args.expectedVersion) {
      return toolFailure(
        "stale-version",
        `replace refused: expected ${args.expectedVersion} but observed ${currentVersion}`,
        false,
      );
    }
    const text = before.toString("utf8");
    const first = text.indexOf(args.oldText);
    if (first === -1) {
      return toolFailure("precondition", "replace refused: oldText not found literally", false);
    }
    if (text.indexOf(args.oldText, first + 1) !== -1) {
      return toolFailure("precondition", "replace refused: oldText matches more than once", false);
    }
    const eol = detectEol(text);
    let newText = text.slice(0, first) + args.newText + text.slice(first + args.oldText.length);
    if (eol === "\r\n") {
      newText = newText.replace(/\r(?!\n)|(?<!\r)\n/g, "\r\n");
    }
    fs.writeFileSync(absolute, newText);
    const after = contentVersion(Buffer.from(newText, "utf8"));
    const beforeStored = storedPreview(before);
    const afterStored = storedPreview(Buffer.from(newText, "utf8"));
    return {
      status: "completed",
      summary: `replaced one literal occurrence in ${args.path}`,
      detail: JSON.stringify({
        beforeVersion: currentVersion,
        afterVersion: after,
        beforeHash: beforeStored.hash,
        beforeTruncated: beforeStored.truncated,
        beforePreview: beforeStored.preview.slice(0, 8000),
        beforePreviewTruncated: beforeStored.truncated || beforeStored.preview.length > 8000,
        afterPreview: afterStored.preview.slice(0, 8000),
        afterPreviewTruncated: afterStored.truncated || afterStored.preview.length > 8000,
      }),
      version: after,
      complete: true,
    };
  }

  private delete(absolute: string, args: Extract<EditOperation, { kind: "delete" }>): ToolResult {
    if (!fs.existsSync(absolute)) {
      return toolFailure("not-found", `delete refused: ${args.path} does not exist`, false);
    }
    if (!fs.statSync(absolute).isFile()) {
      return toolFailure("precondition", `delete refused: ${args.path} is not a file`, false);
    }
    const before = fs.readFileSync(absolute);
    const currentVersion = contentVersion(before);
    if (currentVersion !== args.expectedVersion) {
      return toolFailure(
        "stale-version",
        `delete refused: expected ${args.expectedVersion} but observed ${currentVersion}`,
        false,
      );
    }
    const stored = storedPreview(before);
    fs.unlinkSync(absolute);
    return {
      status: "completed",
      summary: `deleted ${args.path}`,
      detail: JSON.stringify({ beforeVersion: currentVersion, beforeHash: stored.hash, beforeTruncated: stored.truncated }),
      complete: true,
    };
  }

  private rename(absolute: string, args: Extract<EditOperation, { kind: "rename" }>, context: ToolContext): ToolResult {
    if (typeof args.newPath !== "string" || args.newPath === "") {
      return toolFailure("invalid-args", "rename requires newPath", false);
    }
    const destination = resolveInWorkspace(context.workspaceRoot, args.newPath);
    if (destination === null) {
      return toolFailure("invalid-args", "rename destination escapes the workspace", false);
    }
    if (!fs.existsSync(absolute)) {
      return toolFailure("not-found", `rename refused: ${args.path} does not exist`, false);
    }
    const before = fs.readFileSync(absolute);
    const currentVersion = contentVersion(before);
    if (currentVersion !== args.expectedVersion) {
      return toolFailure(
        "stale-version",
        `rename refused: expected ${args.expectedVersion} but observed ${currentVersion}`,
        false,
      );
    }
    if (fs.existsSync(destination)) {
      return toolFailure("precondition", `rename refused: destination ${args.newPath} already exists`, false);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      fs.renameSync(absolute, destination);
    } catch (error) {
      const stillThere = fs.existsSync(absolute);
      const arrived = fs.existsSync(destination);
      return toolFailure(
        "io-error",
        `rename partially applied or failed (source present: ${stillThere}, destination present: ${arrived}): ${error instanceof Error ? error.message : "unknown error"}`,
        true,
      );
    }
    return {
      status: "completed",
      summary: `renamed ${args.path} to ${args.newPath}`,
      detail: JSON.stringify({ beforeVersion: currentVersion, afterVersion: currentVersion }),
      version: currentVersion,
      complete: true,
    };
  }
}
