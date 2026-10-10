import fs from "node:fs";
import path from "node:path";
import { resolveInScope } from "../platform/paths.js";
import type { ExecArgs } from "./exec.js";
import type { ToolResult } from "./types.js";

// This is an observation projection for a deliberately small POSIX query
// syntax, NOT shell equivalence or authority to run a command. Unsupported
// options, effects, substitutions and mixed commands retain the normal key.
export function listingProgress(args: ExecArgs, cwd: string, stdout: string, stderr: string, env: Record<string, string>): ToolResult["progress"] {
  if (args.env !== undefined || args.input !== undefined || stderr.trim() !== "") return undefined;
  let tokens: string[];
  if (args.mode === "shell") {
    if (args.shell !== "sh" || /[;$`&<>\r\n\\]/u.test(args.command)) return undefined;
    const pipeline = args.command.trim().split(/\s*\|\s*/u);
    if (pipeline.length > 2 || (pipeline.length === 2 && !/^sort(?:\s+-r)?$/u.test(pipeline[1] ?? ""))) return undefined;
    const command = (pipeline[0] ?? "").replace(/['"]\.['"]/gu, ".");
    if (/['"]/u.test(command)) return undefined;
    tokens = command.split(/\s+/u);
  } else tokens = [args.executable, ...(args.argv ?? [])];
  const executable = tokens.shift() ?? "";
  const name = path.basename(executable);
  if (name !== "ls" && name !== "find") return undefined;
  const candidates = executable.includes("/") ? [executable] : (env["PATH"] ?? "").split(path.delimiter).map(dir => path.join(dir, executable));
  const binary = candidates.find(candidate => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
  try {
    if (binary === undefined || ![`/usr/bin/${name}`, `/bin/${name}`].some(candidate => fs.existsSync(candidate) && fs.realpathSync(candidate) === fs.realpathSync(binary))) return undefined;
  } catch { return undefined; }
  if (name === "ls") {
    if (tokens.some(token => token !== "." && !/^-[1aA]+$/u.test(token))) return undefined;
  } else {
    if (tokens.shift() !== ".") return undefined;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      if (token === "-print") continue;
      const value = tokens[++index] ?? "";
      if ((token === "-mindepth" || token === "-maxdepth") && /^\d+$/u.test(value)) continue;
      if (token === "-type" && /^(?:f|d)$/u.test(value)) continue;
      return undefined;
    }
  }
  const items: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line === "" || line === "." || line === "..") continue;
    const absolute = resolveInScope(cwd, line);
    if (absolute === null) return undefined;
    try {
      const stat = fs.lstatSync(absolute, { bigint: true });
      items.push(JSON.stringify([path.relative(cwd, absolute), String(stat.mode), String(stat.size), String(stat.mtimeNs), String(stat.ino)]));
    } catch { return undefined; }
  }
  try {
    const root = fs.statSync(cwd, { bigint: true });
    return { scope: `posix-directory-query:${cwd}`, version: `${root.dev}:${root.ino}`, items: [...new Set(items)].sort() };
  } catch { return undefined; }
}
