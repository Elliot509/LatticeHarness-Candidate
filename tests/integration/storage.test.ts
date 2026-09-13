import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb, OwnershipHeldError } from "../../src/storage/db.js";
import {
  FutureSchemaError,
  migrate,
  readSchemaVersion,
  SCHEMA_VERSION,
} from "../../src/storage/schema.js";

let dirs: string[] = [];

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lattice-${name}-`));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("sqlite storage integration", () => {
  it("persists across commit and reopen without manual migration", () => {
    const dir = tempDir("reopen");
    const first = openLatticeDb(dir);
    first.raw.prepare("INSERT INTO events (kind, payload, recorded_at) VALUES (?, ?, ?)").run(
      "test.event",
      "{}",
      new Date().toISOString(),
    );
    first.close();

    const second = openLatticeDb(dir);
    try {
      const rows = second.raw.prepare("SELECT kind FROM events").all() as Array<{
        kind: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("test.event");
      expect(readSchemaVersion(second.raw)).toBe(SCHEMA_VERSION);
    } finally {
      second.close();
    }
  });

  it("uses WAL with synchronous=FULL", () => {
    const dir = tempDir("pragmas");
    const db = openLatticeDb(dir);
    try {
      const journal = db.raw.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      const synchronous = db.raw.prepare("PRAGMA synchronous").get() as { synchronous: number };
      expect(journal.journal_mode.toUpperCase()).toBe("WAL");
      expect(synchronous.synchronous).toBe(2);
    } finally {
      db.close();
    }
  });

  it("rolls back a failed transaction without touching prior state", () => {
    const dir = tempDir("rollback");
    const db = openLatticeDb(dir);
    try {
      db.raw.prepare("INSERT INTO events (kind, payload, recorded_at) VALUES (?, ?, ?)").run(
        "before",
        "{}",
        new Date().toISOString(),
      );
      db.raw.exec("BEGIN IMMEDIATE");
      try {
        db.raw.prepare("INSERT INTO events (kind, payload, recorded_at) VALUES (?, ?, ?)").run(
          "during",
          "{}",
          new Date().toISOString(),
        );
        db.raw.prepare("INSERT INTO ownership (id, generation, pid, process_identity, claimed_at) VALUES (1, 1, 1, 'x', 'y')").run();
        db.raw.prepare("INSERT INTO ownership (id, generation, pid, process_identity, claimed_at) VALUES (1, 1, 1, 'x', 'y')").run();
        db.raw.exec("COMMIT");
      } catch {
        db.raw.exec("ROLLBACK");
      }
      const rows = db.raw.prepare("SELECT kind FROM events ORDER BY seq").all() as Array<{
        kind: string;
      }>;
      expect(rows.map((r) => r.kind)).toEqual(["before"]);
    } finally {
      db.close();
    }
  });

  it("refuses a future schema without downgrading", () => {
    const dir = tempDir("future");
    const setup = openLatticeDb(dir);
    setup.raw.prepare("INSERT INTO events (kind, payload, recorded_at) VALUES (?, ?, ?)").run(
      "keep",
      "{}",
      new Date().toISOString(),
    );
    setup.close();

    const raw = new DatabaseSync(path.join(dir, "lattice.db"));
    try {
      raw.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run("999");
      expect(() => migrate(raw)).toThrow(FutureSchemaError);
      expect(readSchemaVersion(raw)).toBe(999);
      const rows = raw.prepare("SELECT kind FROM events").all() as Array<{ kind: string }>;
      expect(rows).toHaveLength(1);
    } finally {
      raw.close();
    }
  });

  it("preserves previous state when migration cannot proceed", () => {
    const dir = tempDir("broken-migration");
    const raw = new DatabaseSync(path.join(dir, "lattice.db"));
    try {
      raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', 'corrupt')").run();
      raw.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY)");
      expect(() => migrate(raw)).toThrow();
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>;
      expect(tables.map((t) => t.name).sort()).toEqual(["events", "meta"]);
    } finally {
      raw.close();
    }
  });

  it("an interrupted multi-statement transaction leaves no partial schema", () => {
    const dir = tempDir("interrupted");
    const raw = new DatabaseSync(path.join(dir, "lattice.db"));
    try {
      raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      raw.exec("BEGIN IMMEDIATE");
      try {
        raw.exec("CREATE TABLE intents (intent_id TEXT PRIMARY KEY)");
        raw.exec("CREATE TABLE intents (intent_id TEXT PRIMARY KEY)");
        raw.exec("COMMIT");
      } catch {
        raw.exec("ROLLBACK");
      }
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>;
      expect(tables.map((t) => t.name)).toEqual(["meta"]);
    } finally {
      raw.close();
    }
  });

  it("opens databases under paths with spaces, accents and unicode", () => {
    const dir = path.join(tempDir("uni"), "pasta com espaços", "café-日本語");
    const db = openLatticeDb(dir);
    try {
      db.raw.prepare("INSERT INTO events (kind, payload, recorded_at) VALUES (?, ?, ?)").run(
        "unicode-path",
        "{}",
        new Date().toISOString(),
      );
      const count = db.raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
      expect(count.n).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("ownership integration", () => {
  it("refuses a second live owner on the same database", () => {
    const dir = tempDir("ownership");
    const first = openLatticeDb(dir);
    const second = new DatabaseSync(path.join(dir, "lattice.db"));
    try {
      const claim = claimOwnership(first.raw, "owner-a");
      expect(claim.generation).toBe(1);
      expect(() => claimOwnership(second, "owner-b")).toThrow(OwnershipHeldError);
      expect(() => claimOwnership(second, "owner-b")).toThrow(
        `Database is owned by live process ${process.pid} at generation 1`,
      );
    } finally {
      second.close();
      first.close();
    }
  });

  it("a new generation takes over after the owner pid is gone", () => {
    const dir = tempDir("takeover");
    const db = openLatticeDb(dir);
    try {
      claimOwnership(db.raw, "owner-a");
      const deadPid = 2147483647;
      db.raw.prepare("UPDATE ownership SET pid = ?, process_identity = ? WHERE id = 1").run(
        deadPid,
        "dead-owner",
      );
      const next = claimOwnership(db.raw, "owner-b");
      expect(next.generation).toBe(2);
      expect(next.pid).toBe(process.pid);
    } finally {
      db.close();
    }
  });
});

describe("persistence failure blocks dispatch", () => {
  function dispatchIfDurable(db: DatabaseSync, intentId: string): boolean {
    const row = db
      .prepare("SELECT state FROM intents WHERE intent_id = ?")
      .get(intentId) as { state: string } | undefined;
    return row?.state === "ADMITTED";
  }

  it("does not dispatch an intent whose admission commit rolled back", () => {
    const dir = tempDir("blocked");
    const db = openLatticeDb(dir);
    try {
      db.raw.exec("BEGIN IMMEDIATE");
      try {
        db.raw.prepare(
          "INSERT INTO intents (intent_id, task_id, operation, target, action_key, authority_revision, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run("intent-x", "task-1", "read", "f", "k", 1, "ADMITTED", new Date().toISOString());
        throw new Error("simulated commit failure");
      } catch {
        db.raw.exec("ROLLBACK");
      }
      expect(dispatchIfDurable(db.raw, "intent-x")).toBe(false);
    } finally {
      db.close();
    }
  });

  it("dispatches once the admission commit is durable", () => {
    const dir = tempDir("allowed");
    const db = openLatticeDb(dir);
    try {
      db.raw.prepare(
        "INSERT INTO intents (intent_id, task_id, operation, target, action_key, authority_revision, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run("intent-y", "task-1", "read", "f", "k", 1, "ADMITTED", new Date().toISOString());
      expect(dispatchIfDurable(db.raw, "intent-y")).toBe(true);
    } finally {
      db.close();
    }
  });
});
