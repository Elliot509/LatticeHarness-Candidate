import type {
  ModelRequest,
  ModelResponse,
  ProviderAdapter,
} from "./types.js";

export interface FakeScriptStep {
  text?: string;
  toolCalls?: Array<{ id?: string; name: string; argumentsJson?: string }>;
  usage?: ModelResponse["usage"];
  modelResolved?: string | null;
  failWith?: "network" | "timeout" | "server-error" | "rate-limited";
}

export class FakeProviderExhaustedError extends Error {
  constructor() {
    super("Fake provider script exhausted: no further response programmed");
    this.name = "FakeProviderExhaustedError";
  }
}

export class FakeProviderError extends Error {
  readonly simulatedKind: NonNullable<FakeScriptStep["failWith"]>;
  constructor(kind: NonNullable<FakeScriptStep["failWith"]>) {
    super(`Fake provider simulated failure: ${kind}`);
    this.name = "FakeProviderError";
    this.simulatedKind = kind;
  }
}

// Scripted stand-in for a model: returns programmed responses in order and
// records every request for assertions. It exercises the runtime (admission,
// claim, receipt, budget, verification); it is not evidence of model skill.
export class FakeProvider implements ProviderAdapter {
  readonly name = "fake";
  readonly adapterRevision = "fake-1";
  private readonly steps: FakeScriptStep[];
  private cursor = 0;
  readonly requests: ModelRequest[] = [];

  constructor(steps: FakeScriptStep[]) {
    this.steps = steps.map((step) => ({ ...step }));
  }

  get consumedSteps(): number {
    return this.cursor;
  }

  get remainingSteps(): number {
    return this.steps.length - this.cursor;
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const step = this.steps[this.cursor];
    if (step === undefined) return Promise.reject(new FakeProviderExhaustedError());
    this.cursor += 1;
    if (request.signal?.aborted === true) {
      return Promise.reject(new FakeProviderError("network"));
    }
    if (step.failWith !== undefined) {
      return Promise.reject(new FakeProviderError(step.failWith));
    }
    return Promise.resolve({
      text: step.text ?? "",
      toolCalls: (step.toolCalls ?? []).map((call, index) => ({
        id: call.id ?? `fakecall-${this.cursor}-${index}`,
        name: call.name,
        argumentsJson: call.argumentsJson ?? "{}",
      })),
      usage: step.usage ?? null,
      modelResolved: step.modelResolved ?? "fake-model-1",
      providerRequestId: `fake-req-${this.cursor}`,
    });
  }
}
