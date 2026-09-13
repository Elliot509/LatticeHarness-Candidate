import {
  findGrant,
  isContractExpired,
  type TaskContract,
} from "./contract.js";
import { BudgetLedger } from "./budget.js";

export interface ActionIntent {
  intentId: string;
  operation: string;
  target: string | null;
  actionKey: string;
  authorityRevision: number;
  maxCalls: number;
  maxTokens: number;
}

export interface AdmissionTicket {
  readonly intentId: string;
  readonly operation: string;
  readonly generation: number;
  readonly contractRevision: number;
  readonly reservedCalls: number;
  readonly reservedTokens: number;
  claimed: boolean;
}

export type AdmissionDenialReason =
  | "no-grant"
  | "contract-expired"
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
  now?: Date | undefined;
}

export function admitIntent(request: AdmissionRequest): AdmissionResult {
  const now = request.now ?? new Date();
  if (isContractExpired(request.contract, now)) {
    return {
      admitted: false,
      reason: "contract-expired",
      detail: `Contract for task ${request.contract.taskId} expired at ${request.contract.expiresAt}`,
    };
  }
  if (request.intent.authorityRevision !== request.contract.revision) {
    return {
      admitted: false,
      reason: "stale-revision",
      detail: `Intent expects revision ${request.intent.authorityRevision} but contract is at ${request.contract.revision}`,
    };
  }
  const grant = findGrant(request.contract, request.intent.operation, now);
  if (grant === null) {
    return {
      admitted: false,
      reason: "no-grant",
      detail: `No vigente grant covers operation ${request.intent.operation}`,
    };
  }
  if (request.ownerGeneration <= 0) {
    return {
      admitted: false,
      reason: "stale-generation",
      detail: "No owner generation claimed; dispatch is not authorized",
    };
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
      claimed: false,
    },
  };
}

export type ClaimDenialReason = "already-claimed" | "stale-generation" | "stale-revision";

export interface ClaimResult {
  readonly claimed: boolean;
  readonly reason?: ClaimDenialReason | undefined;
}

export function claimTicket(
  ticket: AdmissionTicket,
  ownerGeneration: number,
  contractRevision: number,
): ClaimResult {
  if (ticket.claimed) return { claimed: false, reason: "already-claimed" };
  if (ownerGeneration !== ticket.generation) {
    return { claimed: false, reason: "stale-generation" };
  }
  if (contractRevision !== ticket.contractRevision) {
    return { claimed: false, reason: "stale-revision" };
  }
  ticket.claimed = true;
  return { claimed: true };
}
