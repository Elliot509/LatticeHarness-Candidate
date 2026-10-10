import type { ToolDefinition } from "../providers/types.js";
import { summarizeExecResult, type VerifyResult } from "../runtime/verify.js";
import { EDIT_DEFINITION, EditTool, type EditOperation } from "./edit.js";
import { EXEC_DEFINITION, ExecTool, type ExecArgs } from "./exec.js";
import { HandleRegistry } from "./handles.js";
import { PROCESS_DEFINITION, ProcessSupervisor, type ProcessOperation } from "./process.js";
import { READ_DEFINITION, ReadTool, type ReadArgs } from "./read.js";
import { SEARCH_DEFINITION, SearchTool, type SearchArgs } from "./search.js";
import { parseToolArgs, toolFailure, type ToolContext, type ToolResult } from "./types.js";

export interface VerifyTrigger {
  executable: string;
  argv: string[];
  onResult: (result: VerifyResult) => void;
}

export interface ToolsetOptions {
  directoryOnly?: boolean;
  handles?: HandleRegistry;
  supervisor?: ProcessSupervisor;
  verifyTriggers?: VerifyTrigger[];
}

function matchesTrigger(trigger: VerifyTrigger, executable: string, argv: string[]): boolean {
  return trigger.executable === executable && JSON.stringify(trigger.argv) === JSON.stringify(argv);
}

function decodeArgs(argsJson: string): Record<string, unknown> {
  const parsed = parseToolArgs(argsJson);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

export interface RegisteredToolEntry {
  name: string;
  definition: ToolDefinition;
  run(argsJson: string, context: ToolContext): Promise<{ result: ToolResult; argsSummary: string }>;
}

export function buildToolset(options: ToolsetOptions = {}): RegisteredToolEntry[] {
  const handles = options.handles ?? new HandleRegistry();
  const search = new SearchTool(handles);
  const read = new ReadTool(handles);
  const edit = new EditTool();
  const exec = new ExecTool();
  const tools: RegisteredToolEntry[] = [
    {
      name: "search",
      definition: SEARCH_DEFINITION,
      run: async (argsJson, context) => ({
        result: await search.execute(decodeArgs(argsJson) as unknown as SearchArgs, context),
        argsSummary: argsJson,
      }),
    },
    {
      name: "read",
      definition: READ_DEFINITION,
      run: async (argsJson, context) => ({
        result: await read.execute(decodeArgs(argsJson) as unknown as ReadArgs, context),
        argsSummary: argsJson,
      }),
    },
    {
      name: "edit",
      definition: EDIT_DEFINITION,
      run: async (argsJson, context) => ({
        result: await edit.execute(decodeArgs(argsJson) as unknown as EditOperation, context),
        argsSummary: argsJson,
      }),
    },
    {
      name: "exec",
      definition: EXEC_DEFINITION,
      run: async (argsJson, context) => {
        const args = decodeArgs(argsJson) as unknown as ExecArgs;
        const startedAt = Date.now();
        const result = await exec.execute(args, context);
        if (args.mode !== "shell" && typeof args.executable === "string") {
          for (const trigger of options.verifyTriggers ?? []) {
            if (matchesTrigger(trigger, args.executable, args.argv ?? [])) {
              trigger.onResult(
                summarizeExecResult(
                  `${args.executable} ${(args.argv ?? []).join(" ")}`,
                  context.workspaceRoot,
                  result,
                  Date.now() - startedAt,
                ),
              );
            }
          }
        }
        return { result, argsSummary: argsJson };
      },
    },
    {
      name: "process",
      definition: PROCESS_DEFINITION,
      run: async (argsJson, context) => {
        const supervisor = options.supervisor;
        if (supervisor === undefined) {
          throw new Error("process tool requires a supervisor for this run");
        }
        const requested = decodeArgs(argsJson) as unknown as ProcessOperation;
        // Executor identity comes from the claimed runtime context, never
        // model-supplied generation/realm/attempt metadata.
        const args: ProcessOperation = requested.op === "spawn"
          ? { ...requested, generation: context.ownerGeneration ?? requested.generation, realm: context.realm, attemptId: context.attemptId ?? requested.attemptId }
          : { ...requested, generation: context.ownerGeneration ?? requested.generation };
        // The tool-context overlay authorizes extra child env for this
        // dispatch only; merge it into the per-spawn args env explicitly so
        // the supervisor boundary stays the single choke point.
        const overlay = (context as { envOverlay?: Record<string, string> }).envOverlay;
        const merged =
          overlay !== undefined && Object.keys(overlay).length > 0 && args.op === "spawn"
            ? { ...args, env: { ...(args.env ?? {}), ...overlay } }
            : args;
        return { result: await supervisor.execute(merged), argsSummary: argsJson };
      },
    },
  ];
  if (options.directoryOnly === true) {
    const tool = tools.find(tool => tool.name === "read");
    if (tool === undefined) throw new Error("directory reader missing");
    const run = tool.run.bind(tool);
    tool.definition = { ...READ_DEFINITION, parameters: { type: "object", properties: {
      path: { type: "string" }, kind: { type: "string", enum: ["directory"] }, recursive: { type: "boolean" }, cursor: { type: "string" }, pageSize: { type: "number" },
    }, required: ["path", "kind"], additionalProperties: false } };
    tool.run = async (argsJson, context) => {
      const parsed = parseToolArgs(argsJson);
      if (!parsed.ok || parsed.value["kind"] !== "directory" || Object.keys(parsed.value).some(key => !["path", "kind", "recursive", "cursor", "pageSize"].includes(key))) return { result: toolFailure("invalid-args", "This inventory task requires read kind=directory, path and optionally recursive/cursor/pageSize", false), argsSummary: argsJson };
      return run(argsJson, context);
    };
    return [tool];
  }
  // Preserve bounded command output for expansion rather than asking the
  // model to rerun an effectful command to recover an omitted preview.
  for (const tool of tools) {
    const run = tool.run.bind(tool);
    tool.run = async (argsJson, context) => {
      const out = await run(argsJson, context);
      if ((out.result.detail?.length ?? 0) > 4000 && out.result.handleId === undefined) {
        const captured = out.result.detail ?? "";
        out.result.handleId = handles.store("output", `${tool.name} captured output`, () => captured);
        out.result.truncationNote = `Model preview is bounded; recover captured output with read path="." handleId=${out.result.handleId} offset=0 maxBytes=3000. Executor truncation=${out.result.truncated === true}; omitted executor bytes cannot be recovered.`;
      }
      return out;
    };
  }
  return tools;
}
