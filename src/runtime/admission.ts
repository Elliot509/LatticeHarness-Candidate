import type { TaskContract } from "./contract.js";
import {
  evaluateAuthority,
  type AuthorityReason,
} from "./authority.js";
import { BudgetLedger } from "./budget.js";

export interface ActionIntent {
  intentId: string;
  operation: string;
  target: string | null;
  actionKey: string;
  authorityRevision: number;
  maxCalls: number;
  maxTokens: number;
  provider?: string | undefined;
  model?: string | undefined;
  realm?: string | undefined;
}

export interface AdmissionTicket {
  readonly intentId: string;
  readonly operation: string;
  readonly generation: number;
  readonly contractRevision: number;
  readonly reservedCalls: number;
  readonly reservedTokens: number;
  // Identity of the granting grant (SHA-256 over canonical serialization):
  // the claim revalidates that THIS grant is still vigente. Additive: older
  // tickets without a digest revalidate by operation + revision only.
  readonly grantDigest?: string | undefined;
  claimed: boolean;
}

export type AdmissionDenialReason =
  | "no-grant"
  | "contract-expired"
  | "grant-expired"
  | "operation-not-granted"
  | "target-not-granted"
  | "provider-not-granted"
  | "model-not-granted"
  | "realm-not-granted"
  | "restriction-denied"
  | "stale-revision"
  | "stale-generation"
  | "budget-exceeded";

export interface AdmissionDenied {
  readonly admitted: false;
  readonly reason: AdmissionDenialReason;
  readonly detail: string;
}

export interface AdmissionGranted {
  readonly admitted: true;
  readonly ticket: AdmissionTicket;
}

export type AdmissionResult = AdmissionGranted | AdmissionDenied;

export interface AdmissionRequest {
  intent: ActionIntent;
  contract: TaskContract;
  ledger: BudgetLedger;
  ownerGeneration: number;
  // Canonical workspace root the target gate resolves against. Callers that
  // admit path-scoped operations (read/edit) must pass the task workspace;
  // non-path operations ignore it. Required: no ambient default.
  workspaceRoot: string;
  now?: Date | undefined;
}

export function admitIntent(request: AdmissionRequest): AdmissionResult {
  const now = request.now ?? new Date();
  const decision = evaluateAuthority(
    request.contract,
    {
      operation: request.intent.operation,
      target: request.intent.target,
      authorityRevision: request.intent.authorityRevision,
      ...(request.intent.provider !== undefined ? { provider: request.intent.provider } : {}),
      ...(request.intent.model !== undefined ? { model: request.intent.model } : {}),
      ...(request.intent.realm !== undefined ? { realm: request.intent.realm } : {}),
    },
    { ownerGeneration: request.ownerGeneration, workspaceRoot: request.workspaceRoot, now },
  );
  if (!decision.allowed) {
    return { admitted: false, reason: mapReason(decision.reason), detail: decision.detail };
  }
  const reservation = { calls: request.intent.maxCalls, tokens: request.intent.maxTokens };
  if (!request.ledger.canReserve(reservation)) {
    return {
      admitted: false,
      reason: "budget-exceeded",
      detail: "Reservation would exceed granted budget (settled + reserved <= granted)",
    };
  }
  request.ledger.reserve(reservation);
  return {
    admitted: true,
    ticket: {
      intentId: request.intent.intentId,
      operation: request.intent.operation,
      generation: request.ownerGeneration,
      contractRevision: request.contract.revision,
      reservedCalls: reservation.calls,
      reservedTokens: reservation.tokens,
      grantDigest: decision.grantDigest,
      claimed: false,
    },
  };
}

function mapReason(reason: AuthorityReason): AdmissionDenialReason {
  switch (reason) {
    case "operation-not-granted":
      return "no-grant";
    default:
      return reason;
  }
}

export type ClaimDenialReason =
  | "already-claimed"
  | "stale-generation"
  | "stale-revision"
  | "contract-expired"
  | "grant-expired"
  | "grant-changed"
  | "target-not-granted"
  | "provider-not-granted"
  | "model-not-granted"
  | "realm-not-granted"
  | "restriction-denied"
  | "operation-not-granted";

export interface ClaimResult {
  readonly claimed: boolean;
  readonly reason?: ClaimDenialReason | undefined;
}

export function claimTicket(
  ticket: AdmissionTicket,
  ownerGeneration: number,
  contractRevision: number,
  revalidation?: {
    contract: TaskContract;
    operation: string;
    target: string | null;
    provider?: string | undefined;
    model?: string | undefined;
    realm?: string | undefined;
    workspaceRoot: string;
    now?: Date | undefined;
  },
): ClaimResult {
  if (ticket.claimed) return { claimed: false, reason: "already-claimed" };
  if (ownerGeneration !== ticket.generation) {
    return { claimed: false, reason: "stale-generation" };
  }
  if (contractRevision !== ticket.contractRevision) {
    return { claimed: false, reason: "stale-revision" };
  }
  if (revalidation !== undefined) {
    const decision = evaluateAuthority(
      revalidation.contract,
      {
        operation: revalidation.operation,
        target: revalidation.target,
        authorityRevision: contractRevision,
        ...(revalidation.provider !== undefined ? { provider: revalidation.provider } : {}),
        ...(revalidation.model !== undefined ? { model: revalidation.model } : {}),
        ...(revalidation.realm !== undefined ? { realm: revalidation.realm } : {}),
      },
      { ownerGeneration, workspaceRoot: revalidation.workspaceRoot, now: revalidation.now },
    );
    if (!decision.allowed) {
      return { claimed: false, reason: mapClaimReason(decision.reason) };
    }
    if (ticket.grantDigest !== undefined && decision.grantDigest !== ticket.grantDigest) {
      return { claimed: false, reason: "grant-changed" };
    }
  }
  ticket.claimed = true;
  return { claimed: true };
}

function mapClaimReason(reason: AuthorityReason): ClaimDenialReason {
  switch (reason) {
    case "operation-not-granted":
      return "operation-not-granted";
    default:
      return reason;
  }
}
