import { claimOwnership, openLatticeDb } from "../storage/db.js";
import { openBrowser } from "../server/open.js";
import { serveLattice } from "../server/server.js";

export interface UiCommandOptions {
  workspace: string;
  dataDir: string;
  port?: number;
  openBrowser?: boolean;
  onOutput?: (line: string) => void;
  onReady?: (url: string) => void;
}

// Opens the local UI: storage/runtime, loopback server, printed address and
// best-effort browser launch. Resolves when the process is interrupted.
export async function uiCommand(options: UiCommandOptions): Promise<number> {
  const emit = options.onOutput ?? ((line: string) => process.stdout.write(`${line}\n`));
  const db = openLatticeDb(options.dataDir);
  try {
    claimOwnership(db.raw);
  } catch (error) {
    emit(`lattice: cannot claim ownership: ${error instanceof Error ? error.message : "unknown error"}`);
    db.close();
    return 1;
  }
  let server: Awaited<ReturnType<typeof serveLattice>>;
  try {
    server = await serveLattice({
      db: db.raw,
      workspace: options.workspace,
      dataDir: options.dataDir,
      ...(options.port !== undefined ? { port: options.port } : {}),
    });
  } catch (error) {
    emit(`lattice: cannot start server: ${error instanceof Error ? error.message : "unknown error"}`);
    db.close();
    return 1;
  }
  emit(`lattice ui: ${server.url} (workspace ${options.workspace})`);
  options.onReady?.(server.url);
  if (options.openBrowser !== false) {
    const opened = await openBrowser(server.url);
    if (!opened) {
      emit("lattice ui: could not open a browser automatically; use the address above");
    }
  }
  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  await server.close();
  db.close();
  return 0;
}
