export interface BudgetGrant {
  // R1 semantics (D-R1-02): the cognitive budget. `calls` counts MODEL
  // calls (model.invoke admissions); `tokens` counts MODEL tokens
  // (input+output usage settled from provider reports). Tool dispatches
  // never consume these dimensions: they reserve/settle 0/0 and remain
  // identified, counted attempts in the ledger (see effects.ts), with their
  // own optional durable execution-activity limit (maxToolDispatches).
  calls: number;
  tokens: number;
}

export interface BudgetUsage {
  calls: number;
  tokens: number;
}

export class BudgetExceededError extends Error {
  constructor(dimension: string) {
    super(`Budget exhausted: cannot reserve ${dimension} without exceeding grant`);
    this.name = "BudgetExceededError";
  }
}

export class BudgetDoubleSettleError extends Error {
  constructor(attemptId: string) {
    super(`Attempt ${attemptId} already settled`);
    this.name = "BudgetDoubleSettleError";
  }
}

export class BudgetLedger {
  private readonly granted: BudgetGrant;
  private reserved: BudgetUsage = { calls: 0, tokens: 0 };
  private settled: BudgetUsage = { calls: 0, tokens: 0 };
  private readonly settledAttempts = new Set<string>();

  constructor(granted: BudgetGrant) {
    if (!Number.isInteger(granted.calls) || granted.calls <= 0) {
      throw new Error("granted.calls must be a positive integer");
    }
    if (!Number.isInteger(granted.tokens) || granted.tokens <= 0) {
      throw new Error("granted.tokens must be a positive integer");
    }
    this.granted = { ...granted };
  }

  snapshot(): { granted: BudgetGrant; reserved: BudgetUsage; settled: BudgetUsage } {
    return {
      granted: { ...this.granted },
      reserved: { ...this.reserved },
      settled: { ...this.settled },
    };
  }

  canReserve(request: BudgetUsage): boolean {
    return (
      this.settled.calls + this.reserved.calls + request.calls <= this.granted.calls &&
      this.settled.tokens + this.reserved.tokens + request.tokens <= this.granted.tokens
    );
  }

  reserve(request: BudgetUsage): void {
    if (!Number.isInteger(request.calls) || request.calls < 0) {
      throw new Error("request.calls must be a non-negative integer");
    }
    if (!Number.isInteger(request.tokens) || request.tokens < 0) {
      throw new Error("request.tokens must be a non-negative integer");
    }
    if (!this.canReserve(request)) {
      throw new BudgetExceededError(
        this.settled.calls + this.reserved.calls + request.calls > this.granted.calls
          ? "calls"
          : "tokens",
      );
    }
    this.reserved.calls += request.calls;
    this.reserved.tokens += request.tokens;
  }

  settle(attemptId: string, observed: BudgetUsage): void {
    if (this.settledAttempts.has(attemptId)) {
      throw new BudgetDoubleSettleError(attemptId);
    }
    if (observed.calls > this.reserved.calls || observed.tokens > this.reserved.tokens) {
      throw new BudgetExceededError("settlement exceeding reservation");
    }
    this.reserved.calls -= observed.calls;
    this.reserved.tokens -= observed.tokens;
    this.settled.calls += observed.calls;
    this.settled.tokens += observed.tokens;
    this.settledAttempts.add(attemptId);
  }

  release(request: BudgetUsage): void {
    this.reserved.calls = Math.max(0, this.reserved.calls - request.calls);
    this.reserved.tokens = Math.max(0, this.reserved.tokens - request.tokens);
  }

  settledAttemptCount(): number {
    return this.settledAttempts.size;
  }
}
