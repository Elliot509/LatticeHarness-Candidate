import path from "node:path";
import { resolveDataDir, type DataDirEnv } from "../platform/paths.js";

export function desktopOptions(env: DataDirEnv & { LATTICE_DESKTOP_DATA_DIR?: string; LATTICE_DESKTOP_WORKSPACE?: string } = process.env): { workspace: string; dataDir: string; browserDir: string } {
  const override = env.LATTICE_DESKTOP_DATA_DIR?.trim();
  const dataDir = override ? path.resolve(override) : resolveDataDir({ env });
  return { workspace: env.LATTICE_DESKTOP_WORKSPACE?.trim() ?? "", dataDir, browserDir: path.join(dataDir, "browser-state") };
}
