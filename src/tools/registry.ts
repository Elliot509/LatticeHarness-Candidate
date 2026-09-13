import type { ToolDefinition } from "../providers/types.js";
import { summarizeExecResult, type VerifyResult } from "../runtime/verify.js";
import { EDIT_DEFINITION, EditTool, type EditOperation } from "./edit.js";
import { EXEC_DEFINITION, ExecTool, type ExecArgs } from "./exec.js";
import { HandleRegistry } from "./handles.js";
import { PROCESS_DEFINITION, ProcessSupervisor, type ProcessOperation } from "./process.js";
import { READ_DEFINITION, ReadTool, type ReadArgs } from "./read.js";
import { SEARCH_DEFINITION, SearchTool, type SearchArgs } from "./search.js";
import { parseToolArgs, type ToolContext, type ToolResult } from "./types.js";

export interface VerifyTrigger {
  executable: string;
  argv: string[];
  onResult: (result: VerifyResult) => void;
}

export interface ToolsetOptions {
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
  return [
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
      run: async (argsJson, _context) => {
        const supervisor = options.supervisor;
        if (supervisor === undefined) {
          throw new Error("process tool requires a supervisor for this run");
        }
        return { result: await supervisor.execute(decodeArgs(argsJson) as unknown as ProcessOperation), argsSummary: argsJson };
      },
    },
  ];
}
