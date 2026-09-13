import { describe, expect, it } from "vitest";
import {
  BudgetDoubleSettleError,
  BudgetExceededError,
  BudgetLedger,
} from "../../src/runtime/budget.js";

describe("budget ledger conservation", () => {
  it("reserves within grant and settles observed usage", () => {
    const ledger = new BudgetLedger({ calls: 2, tokens: 1000 });
    ledger.reserve({ calls: 1, tokens: 400 });
    ledger.settle("attempt-1", { calls: 1, tokens: 300 });
    const snap = ledger.snapshot();
    expect(snap.settled).toEqual({ calls: 1, tokens: 300 });
    expect(snap.reserved).toEqual({ calls: 0, tokens: 100 });
  });

  it("refuses reservation that would exceed the grant", () => {
    const ledger = new BudgetLedger({ calls: 1, tokens: 100 });
    ledger.reserve({ calls: 1, tokens: 100 });
    expect(() => ledger.reserve({ calls: 1, tokens: 1 })).toThrow(BudgetExceededError);
    expect(() => ledger.reserve({ calls: 0, tokens: 1 })).toThrow(BudgetExceededError);
  });

  it("counts both dimensions independently at the cap", () => {
    const ledger = new BudgetLedger({ calls: 50, tokens: 200000 });
    ledger.reserve({ calls: 50, tokens: 200000 });
    expect(ledger.canReserve({ calls: 0, tokens: 0 })).toBe(true);
    expect(ledger.canReserve({ calls: 1, tokens: 0 })).toBe(false);
    expect(ledger.canReserve({ calls: 0, tokens: 1 })).toBe(false);
  });

  it("settles idempotently per attempt and rejects double settle", () => {
    const ledger = new BudgetLedger({ calls: 5, tokens: 5000 });
    ledger.reserve({ calls: 2, tokens: 2000 });
    ledger.settle("attempt-1", { calls: 1, tokens: 500 });
    expect(() => ledger.settle("attempt-1", { calls: 1, tokens: 500 })).toThrow(
      BudgetDoubleSettleError,
    );
    expect(ledger.settledAttemptCount()).toBe(1);
  });

  it("rejects settlement beyond the reservation", () => {
    const ledger = new BudgetLedger({ calls: 5, tokens: 5000 });
    ledger.reserve({ calls: 1, tokens: 100 });
    expect(() => ledger.settle("attempt-9", { calls: 1, tokens: 101 })).toThrow(
      BudgetExceededError,
    );
  });

  it("releases unused reservation without renewing the grant", () => {
    const ledger = new BudgetLedger({ calls: 2, tokens: 1000 });
    ledger.reserve({ calls: 1, tokens: 1000 });
    ledger.release({ calls: 1, tokens: 900 });
    const snap = ledger.snapshot();
    expect(snap.granted).toEqual({ calls: 2, tokens: 1000 });
    expect(snap.settled).toEqual({ calls: 0, tokens: 0 });
    expect(ledger.canReserve({ calls: 1, tokens: 900 })).toBe(true);
  });
});
