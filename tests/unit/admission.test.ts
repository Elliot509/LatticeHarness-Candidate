import { describe, expect, it } from "vitest";
import { admitIntent, claimTicket, type ActionIntent } from "../../src/runtime/admission.js";
import { BudgetLedger } from "../../src/runtime/budget.js";
import { createContract, type TaskContract } from "../../src/runtime/contract.js";

function contract(): TaskContract {
  return createContract({
    taskId: "task-1",
    rootId: "root-1",
    objective: "Fix the failing test",
    scope: ["workspace/src"],
    acceptanceCriteria: ["relevant test passes"],
    obligations: ["preserve baseline"],
    grants: [
      {
        subject: "agent",
        operations: ["read"],
        targets: ["workspace/src"],
        expiresAt: null,
        limits: { maxCalls: 50, maxTokens: 200000 },
      },
    ],
    prohibitions: ["publish"],
    realm: "local-trusted",
    allowedProvider: "acme",
    allowedModel: "m1",
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    retentionPolicy: "retain until explicit deletion",
    origin: "user setup",
  });
}

function intent(overrides: Partial<ActionIntent> = {}): ActionIntent {
  return {
    intentId: "intent-1",
    operation: "read",
    target: "workspace/src/a.ts",
    actionKey: "read:workspace/src/a.ts",
    authorityRevision: 1,
    maxCalls: 1,
    maxTokens: 1000,
    ...overrides,
  };
}

describe("admission and claim", () => {
  it("admits a covered intent and allows a single claim", () => {
    const result = admitIntent({
      intent: intent(),
      contract: contract(),
      ledger: new BudgetLedger({ calls: 50, tokens: 200000 }),
      ownerGeneration: 3,
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(result.ticket.generation).toBe(3);
    expect(claimTicket(result.ticket, 3, 1)).toEqual({ claimed: true });
    expect(claimTicket(result.ticket, 3, 1).claimed).toBe(false);
  });

  it("denies operations without a grant", () => {
    const result = admitIntent({
      intent: intent({ operation: "exec" }),
      contract: contract(),
      ledger: new BudgetLedger({ calls: 50, tokens: 200000 }),
      ownerGeneration: 1,
    });
    expect(result).toMatchObject({ admitted: false, reason: "no-grant" });
  });

  it("denies stale contract revisions", () => {
    const result = admitIntent({
      intent: intent({ authorityRevision: 7 }),
      contract: contract(),
      ledger: new BudgetLedger({ calls: 50, tokens: 200000 }),
      ownerGeneration: 1,
    });
    expect(result).toMatchObject({ admitted: false, reason: "stale-revision" });
  });

  it("denies admission without an owner generation", () => {
    const result = admitIntent({
      intent: intent(),
      contract: contract(),
      ledger: new BudgetLedger({ calls: 50, tokens: 200000 }),
      ownerGeneration: 0,
    });
    expect(result).toMatchObject({ admitted: false, reason: "stale-generation" });
  });

  it("denies admission that would exceed budget", () => {
    const result = admitIntent({
      intent: intent({ maxCalls: 51, maxTokens: 1 }),
      contract: contract(),
      ledger: new BudgetLedger({ calls: 50, tokens: 200000 }),
      ownerGeneration: 1,
    });
    expect(result).toMatchObject({ admitted: false, reason: "budget-exceeded" });
  });

  it("rejects claims from a stale generation or revised contract", () => {
    const result = admitIntent({
      intent: intent(),
      contract: contract(),
      ledger: new BudgetLedger({ calls: 50, tokens: 200000 }),
      ownerGeneration: 2,
    });
    expect(result.admitted).toBe(true);
    if (!result.admitted) return;
    expect(claimTicket(result.ticket, 1, 1)).toMatchObject({
      claimed: false,
      reason: "stale-generation",
    });
    expect(claimTicket(result.ticket, 2, 2)).toMatchObject({
      claimed: false,
      reason: "stale-revision",
    });
    expect(claimTicket(result.ticket, 2, 1).claimed).toBe(true);
  });
});
