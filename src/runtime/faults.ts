import { PersistenceError } from "../storage/db.js";

// Controlled fault injection for crash-boundary and persistence-failure
// tests. Production code never arms a fault: only tests call arm(). Each
// choke point in the durable path consults throwIfFault() before committing,
// so a test can interrupt the exact protocol step under study and then
// observe the persisted state after a real close/reopen cycle.
//
// Faults are process-global and cleared explicitly; tests must clear them in
// a finally/afterEach so one test cannot poison another.
export type FaultPoint =
  | "before-admitted-commit"
  | "after-admitted"
  | "before-claim-commit"
  | "after-claim"
  | "before-receipt-commit"
  | "before-cursor-commit"
  | "export-mid-write"
  | "storage-write-fail";

const armed = new Set<FaultPoint>();

export function armFault(point: FaultPoint): void {
  armed.add(point);
}

export function clearFaults(): void {
  armed.clear();
}

export function isFaultArmed(point: FaultPoint): boolean {
  return armed.has(point);
}

// Throws at an exact choke point when the matching fault is armed. The
// storage-write-fail fault simulates a persistence failure (for example a
// full disk) at every durable commit: callers must treat the throw as "no
// commit happened" and never dispatch on its behalf.
export function throwIfFault(point: Exclude<FaultPoint, "storage-write-fail">): void {
  if (armed.has(point)) {
    throw new PersistenceError(`injected fault at ${point}; commit did not happen`, null);
  }
}

export function guardWrites(caller: string): void {
  if (armed.has("storage-write-fail")) {
    throw new PersistenceError(
      `injected storage failure at ${caller}; persistence refused, no dispatch authorized`,
      null,
    );
  }
}
