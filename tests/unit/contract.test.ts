import { describe, expect, it } from "vitest";
import {
  createContract,
  findGrant,
  isContractExpired,
  reviseContract,
  validateContract,
  type TaskContract,
} from "../../src/runtime/contract.js";

function validInput(): Omit<TaskContract, "revision"> {
  return {
    taskId: "task-1",
    rootId: "root-1",
    objective: "Fix the failing test",
    scope: ["workspace/src"],
    acceptanceCriteria: ["relevant test passes"],
    obligations: ["preserve baseline"],
    grants: [
      {
        subject: "agent",
        operations: ["read", "edit"],
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
  };
}

describe("task contract", () => {
  it("creates at revision 1 and revises monotonically", () => {
    const created = createContract(validInput());
    expect(created.revision).toBe(1);
    const revised = reviseContract(created, {
      objective: "Fix the failing test thoroughly",
      origin: "user steering",
    });
    expect(revised.revision).toBe(2);
    expect(revised.objective).toContain("thoroughly");
    expect(created.revision).toBe(1);
  });

  it("rejects contracts without obligations, criteria or origin", () => {
    const errors = validateContract({
      ...validInput(),
      obligations: [],
      acceptanceCriteria: [],
      origin: "  ",
    });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects invalid expiry and grant limits", () => {
    const errors = validateContract({
      ...validInput(),
      expiresAt: "not-a-date",
      grants: [
        {
          subject: "",
          operations: [],
          targets: [],
          expiresAt: "also-bad",
          limits: { maxCalls: 0, maxTokens: -1 },
        },
      ],
    });
    expect(errors.length).toBeGreaterThanOrEqual(5);
  });

  it("detects expiry and expired grants", () => {
    const expired = createContract({
      ...validInput(),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(isContractExpired(expired)).toBe(true);
    expect(findGrant(expired, "read")).toBeNull();

    const live = createContract(validInput());
    expect(isContractExpired(live)).toBe(false);
    expect(findGrant(live, "read")?.subject).toBe("agent");
    expect(findGrant(live, "publish")).toBeNull();
  });

  it("does not match operations covered only by an expired grant", () => {
    const contract = createContract({
      ...validInput(),
      grants: [
        {
          subject: "agent",
          operations: ["exec"],
          targets: ["workspace"],
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          limits: { maxCalls: 5, maxTokens: 1000 },
        },
      ],
    });
    expect(findGrant(contract, "exec")).toBeNull();
  });
});
