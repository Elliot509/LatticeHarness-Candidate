import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const LATTICE_DATA_DIR_ENV = "LATTICE_DATA_DIR";
export const LATTICE_DB_FILENAME = "lattice.db";

export interface DataDirEnv {
  LATTICE_DATA_DIR?: string | undefined;
  XDG_DATA_HOME?: string | undefined;
  LOCALAPPDATA?: string | undefined;
  APPDATA?: string | undefined;
}

export interface DataDirOptions {
  env?: DataDirEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  homedir?: string | undefined;
}

function pickEnv(options: DataDirOptions): DataDirEnv {
  if (options.env !== undefined) return options.env;
  const env = process.env;
  return {
    LATTICE_DATA_DIR: env[LATTICE_DATA_DIR_ENV],
    XDG_DATA_HOME: env["XDG_DATA_HOME"],
    LOCALAPPDATA: env["LOCALAPPDATA"],
    APPDATA: env["APPDATA"],
  };
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

export function resolveDataDir(options: DataDirOptions = {}): string {
  const env = pickEnv(options);
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? os.homedir();

  if (nonEmpty(env.LATTICE_DATA_DIR)) {
    return path.resolve(env.LATTICE_DATA_DIR);
  }
  if (platform === "win32") {
    if (nonEmpty(env.LOCALAPPDATA)) return path.join(env.LOCALAPPDATA, "Lattice");
    if (nonEmpty(env.APPDATA)) {
      return path.join(path.resolve(env.APPDATA, ".."), "Local", "Lattice");
    }
    return path.join(home, "AppData", "Local", "Lattice");
  }
  if (nonEmpty(env.XDG_DATA_HOME)) {
    return path.isAbsolute(env.XDG_DATA_HOME)
      ? path.join(env.XDG_DATA_HOME, "lattice")
      : path.resolve(home, env.XDG_DATA_HOME, "lattice");
  }
  return path.join(home, ".local", "share", "lattice");
}

export function latticeDbPath(dataDir: string): string {
  return path.join(path.resolve(dataDir), LATTICE_DB_FILENAME);
}

export function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p);
}

export function normalizeUserPath(p: string): string {
  return path.normalize(p);
}

function canonicalizeExisting(absolute: string): string | null {
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) return null;
    const canonicalParent = canonicalizeExisting(parent);
    if (canonicalParent === null) return null;
    return path.join(canonicalParent, path.basename(absolute));
  }
}

/**
 * Resolve `requested` against `workspaceRoot` and require the canonical
 * (symlink-free) result to stay inside the canonical root. Lexical
 * containment alone lets a symlink inside the workspace point outside of
 * it; the OS would follow the link past every later check. Returns the
 * canonical absolute path, or null when the request escapes the scope.
 * Missing trailing components resolve through the nearest existing
 * ancestor so not-found/create flows keep their existing behavior.
 */
export function resolveInScope(workspaceRoot: string, requested: string): string | null {
  const rootLexical = path.resolve(workspaceRoot);
  const absolute = path.resolve(rootLexical, requested);
  if (absolute !== rootLexical && !absolute.startsWith(`${rootLexical}${path.sep}`)) return null;
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(rootLexical);
  } catch {
    return null;
  }
  const canonical = canonicalizeExisting(absolute);
  if (canonical === null) return null;
  if (canonical !== canonicalRoot && !canonical.startsWith(`${canonicalRoot}${path.sep}`)) return null;
  return canonical;
}
