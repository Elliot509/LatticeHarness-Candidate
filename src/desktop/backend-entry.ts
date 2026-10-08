// P0 utility-process entry: loads the existing compiled backend behind a
// private typed IPC handshake. No task/runtime/database logic of its own.
import { installBackendChannel } from "./backend.js";

installBackendChannel();

process.on("uncaughtException", (error: unknown) => {
  process.stderr.write(`lattice desktop backend crashed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exit(1);
});
