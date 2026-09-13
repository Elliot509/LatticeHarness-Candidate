import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { latticeDbPath } from "../platform/paths.js";
import { migrate, readSchemaVersion, SCHEMA_VERSION } from "./schema.js";

export { SCHEMA_VERSION };

export class OwnershipHeldError extends Error {
  readonly pid: number;
  readonly generation: number;
  constructor(pid: number, generation: number) {
    super(`Database is owned by live process ${pid} at generation ${generation}`);
    this.name = "OwnershipHeldError";
    this.pid = pid;
    this.generation = generation;
  }
}

export class OwnershipUncertainError extends Error {
  readonly pid: number;
  constructor(pid: number, cause: unknown) {
    super(
      `Cannot prove owner process ${pid} terminated; entering recovery without effects`,
      { cause },
    );
    this.name = "OwnershipUncertainError";
    this.pid = pid;
  }
}

export class PersistenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "PersistenceError";
  }
}

export interface LatticeDb {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly raw: DatabaseSync;
  close(): void;
}

export interface OwnerClaim {
  readonly generation: number;
  readonly pid: number;
  readonly processIdentity: string;
  readonly fresh: boolean;
}

function defaultProcessIdentity(): string {
  return `pid:${process.pid}:ppid:${process.ppid}:${process.execPath}`;
}

function ownerAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new OwnershipUncertainError(pid, error);
  }
}

export function openLatticeDb(dataDir: string): LatticeDb {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    throw new PersistenceError(`Cannot create data directory ${dataDir}`, error);
  }
  const dbPath = latticeDbPath(dataDir);
  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(dbPath);
  } catch (error) {
    throw new PersistenceError(`Cannot open database at ${dbPath}`, error);
  }
  try {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA synchronous = FULL");
    raw.exec("PRAGMA foreign_keys = ON");
    migrate(raw);
  } catch (error) {
    try {
      raw.close();
    } catch {
      // Close failure after a setup failure must not mask the root cause.
    }
    throw error;
  }
  return {
    dataDir,
    dbPath,
    raw,
    close() {
      raw.close();
    },
  };
}

export function currentSchemaVersion(db: DatabaseSync): number {
  return readSchemaVersion(db);
}

export function claimOwnership(
  db: DatabaseSync,
  processIdentity: string = defaultProcessIdentity(),
): OwnerClaim {
  const existing = db
    .prepare("SELECT generation, pid, process_identity FROM ownership WHERE id = 1")
    .get() as
    | { generation: number; pid: number; process_identity: string }
    | undefined;
  if (existing === undefined) {
    db.prepare(
      "INSERT INTO ownership (id, generation, pid, process_identity, claimed_at) VALUES (1, 1, ?, ?, ?)",
    ).run(process.pid, processIdentity, new Date().toISOString());
    return { generation: 1, pid: process.pid, processIdentity, fresh: true };
  }
  if (existing.pid === process.pid && existing.process_identity === processIdentity) {
    return {
      generation: existing.generation,
      pid: process.pid,
      processIdentity,
      fresh: false,
    };
  }
  if (ownerAlive(existing.pid)) {
    throw new OwnershipHeldError(existing.pid, existing.generation);
  }
  const generation = existing.generation + 1;
  db.prepare(
    "UPDATE ownership SET generation = ?, pid = ?, process_identity = ?, claimed_at = ? WHERE id = 1",
  ).run(generation, process.pid, processIdentity, new Date().toISOString());
  return { generation, pid: process.pid, processIdentity, fresh: false };
}

export function readOwnerGeneration(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT generation FROM ownership WHERE id = 1").get() as
    | { generation: number }
    | undefined;
  return row?.generation ?? null;
}
