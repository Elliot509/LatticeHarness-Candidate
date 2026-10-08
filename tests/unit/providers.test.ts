import { describe, expect, it, vi } from "vitest";
import { FakeProvider, FakeProviderExhaustedError } from "../../src/providers/fake.js";
import { OpenAiAdapter, OPENAI_ADAPTER_REVISION } from "../../src/providers/openai.js";
import { ProviderError } from "../../src/providers/types.js";
import type { ModelRequest } from "../../src/providers/types.js";

function request(): ModelRequest {
  return {
    model: "test-model",
    system: "system",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  };
}

describe("fake provider", () => {
  it("replays scripted steps and records requests", async () => {
    const fake = new FakeProvider([
      { toolCalls: [{ name: "search", argumentsJson: "{}" }], usage: { inputTokens: 10, outputTokens: 5 } },
      { text: "done" },
    ]);
    const first = await fake.complete(request());
    expect(first.toolCalls).toHaveLength(1);
    expect(first.usage).toMatchObject({ inputTokens: 10 });
    expect(fake.requests).toHaveLength(1);
    const second = await fake.complete(request());
    expect(second.text).toBe("done");
    expect(second.toolCalls).toEqual([]);
    await expect(fake.complete(request())).rejects.toBeInstanceOf(FakeProviderExhaustedError);
  });

  it("simulates transport failures without inventing usage", async () => {
    const fake = new FakeProvider([{ failWith: "timeout" }]);
    await expect(fake.complete(request())).rejects.toMatchObject({
      name: "FakeProviderError",
      simulatedKind: "timeout",
    });
  });
});

describe("openai adapter contract", () => {
  function stubFetch(response: { ok: boolean; status: number; body: unknown }) {
    return vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status,
      json: () => Promise.resolve(response.body),
      text: () => Promise.resolve(JSON.stringify(response.body)),
    });
  }

  it("sends chat completions and normalizes tool calls plus usage", async () => {
    const fetchImpl = stubFetch({
      ok: true,
      status: 200,
      body: {
        id: "chatcmpl-1",
        model: "gpt-test",
        choices: [
          {
            message: {
              content: "searching",
              tool_calls: [{ id: "call_1", type: "function", function: { name: "search", arguments: "{\"kind\":\"text\"}" } }],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      },
    });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(adapter.adapterRevision).toBe(OPENAI_ADAPTER_REVISION);
    const response = await adapter.complete(request());
    expect(response.toolCalls).toEqual([{ id: "call_1", name: "search", argumentsJson: "{\"kind\":\"text\"}" }]);
    expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(response.modelResolved).toBe("gpt-test");
    expect(response.providerRequestId).toBe("chatcmpl-1");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer synthetic-provider-credential" });
  });

  it("keeps cache partitions unknown when the API reports none", async () => {
    const fetchImpl = stubFetch({
      ok: true,
      status: 200,
      body: {
        id: "x",
        choices: [{ message: { content: "hi" } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      },
    });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await adapter.complete(request());
    expect(response.usage?.cacheReadTokens).toBeUndefined();
    expect(response.usage?.cacheWriteTokens).toBeUndefined();
    // No cache evidence: the input partition convention stays undeclared so
    // telemetry keeps the partitions UNKNOWN (fail-closed, never zero).
    expect(response.usage?.inclusiveInput).toBeUndefined();
  });

  it("reads OpenAI prompt_tokens_details as inclusive cache partitions", async () => {
    // Wire shape per the official OpenAI API (openai-python
    // PromptTokensDetails: cached_tokens / cache_write_tokens inside
    // prompt_tokens_details; prompt_tokens is the inclusive total).
    const fetchImpl = stubFetch({
      ok: true,
      status: 200,
      body: {
        id: "chatcmpl-cache",
        model: "gpt-test",
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
        },
      },
    });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await adapter.complete(request());
    expect(response.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      inclusiveInput: true,
    });
  });

  it("reads the OpenRouter normalized usage shape identically", async () => {
    // OpenRouter ResponseUsage: prompt_tokens inclusive total with
    // prompt_tokens_details { cached_tokens, cache_write_tokens? }.
    // A partial details object is NOT enough to declare the partition
    // convention (telemetry would otherwise derive the missing partition
    // as zero), so the window stays fail-closed downstream; the evidenced
    // partition is still carried as a known quantity.
    const fetchImpl = stubFetch({
      ok: true,
      status: 200,
      body: {
        id: "gen-or-1",
        model: "openai/gpt-test",
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 1100,
          completion_tokens: 50,
          total_tokens: 1150,
          prompt_tokens_details: { cached_tokens: 400 },
        },
      },
    });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await adapter.complete(request());
    expect(response.usage).toMatchObject({
      inputTokens: 1100,
      outputTokens: 50,
      cacheReadTokens: 400,
    });
    expect(response.usage?.cacheWriteTokens).toBeUndefined();
    expect(response.usage?.inclusiveInput).toBeUndefined();
  });

  it("treats explicit zero cache details as known zero", async () => {
    const fetchImpl = stubFetch({
      ok: true,
      status: 200,
      body: {
        id: "chatcmpl-zero",
        model: "gpt-test",
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      },
    });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await adapter.complete(request());
    expect(response.usage).toMatchObject({
      inputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      inclusiveInput: true,
    });
  });

  it("ignores malformed cache details without inventing partitions", async () => {
    const fetchImpl = stubFetch({
      ok: true,
      status: 200,
      body: {
        id: "chatcmpl-bad",
        model: "gpt-test",
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          total_tokens: 120,
          // Wrong types: not evidence. Partitions stay absent; the input
          // convention stays undeclared; telemetry keeps them UNKNOWN.
          prompt_tokens_details: { cached_tokens: "400", cache_write_tokens: -5 },
        },
      },
    });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await adapter.complete(request());
    expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(response.usage?.cacheReadTokens).toBeUndefined();
    expect(response.usage?.cacheWriteTokens).toBeUndefined();
    expect(response.usage?.inclusiveInput).toBeUndefined();
  });

  it("keeps reasoning inside output and out of input/cache accounting", async () => {
    const fetchImpl = stubFetch({
      ok: true,
      status: 200,
      body: {
        id: "chatcmpl-reason",
        model: "gpt-test",
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 100, cache_write_tokens: 50 },
          completion_tokens_details: { reasoning_tokens: 60 },
        },
      },
    });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await adapter.complete(request());
    expect(response.usage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 100,
      cacheWriteTokens: 50,
      reasoningTokens: 60,
      inclusiveInput: true,
    });
  });

  it("normalizes inclusive cache partitions through the ledger without double counting", async () => {
    // End-to-end of the normalization boundary for one documented provider
    // example: prompt_tokens=1000 inclusive, cached=400, write=100,
    // completion=200. Lattice partitions must be disjoint
    // (inputNew = 1000-400-100 = 500).
    const { normalizeUsageQuantities } = await import("../../src/telemetry/usage.js");
    const fetchImpl = stubFetch({
      ok: true,
      status: 200,
      body: {
        id: "chatcmpl-norm",
        model: "gpt-test",
        choices: [{ message: { content: "hi" } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 100 },
        },
      },
    });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await adapter.complete(request());
    const asInt = (value: unknown): number | null =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
    const normalized = normalizeUsageQuantities({
      inputTotal: asInt(response.usage?.inputTokens),
      outputTotal: asInt(response.usage?.outputTokens),
      cacheRead: asInt(response.usage?.cacheReadTokens),
      cacheWrite: asInt(response.usage?.cacheWriteTokens),
      reasoningSubset: asInt(response.usage?.reasoningTokens),
      ...(response.usage?.inclusiveInput === true ? { inclusiveInput: true as const } : {}),
      source: "openai/openai-chat-completions-2",
    });
    expect(normalized.inputNew).toMatchObject({ value: 500, quality: "observed" });
    expect(normalized.cacheRead).toMatchObject({ value: 400, quality: "observed" });
    expect(normalized.cacheWrite).toMatchObject({ value: 100, quality: "observed" });
    expect(normalized.inputTotal).toMatchObject({ value: 1000, quality: "observed" });
    expect(normalized.outputTotal).toMatchObject({ value: 200, quality: "observed" });
  });

  it("maps auth, rate limit and server errors without retrying", async () => {
    for (const [status, kind] of [[401, "auth"], [429, "rate-limited"], [500, "server-error"], [400, "invalid-request"]] as const) {
      const fetchImpl = stubFetch({ ok: false, status, body: { error: { message: "nope" } } });
      const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
      try {
        await adapter.complete(request());
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderError);
        expect((error as ProviderError).kind).toBe(kind);
        expect((error as ProviderError).statusCode).toBe(status);
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("maps network failure and caller abort distinctly", async () => {
    const failing = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: failing as unknown as typeof fetch });
    await expect(adapter.complete(request())).rejects.toMatchObject({ kind: "network" });

    const controller = new AbortController();
    controller.abort();
    const hanging = vi.fn().mockImplementation(((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch);
    const adapter2 = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: hanging });
    await expect(adapter2.complete({ ...request(), signal: controller.signal })).rejects.toMatchObject({
      kind: "aborted",
    });
  });

  it("rejects responses without choices and omits auth for local endpoints", async () => {
    const fetchImpl = stubFetch({ ok: true, status: 200, body: { choices: [] } });
    const adapter = new OpenAiAdapter({ apiKey: "synthetic-provider-credential", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(adapter.complete(request())).rejects.toMatchObject({ kind: "unknown" });

    const localFetch = stubFetch({
      ok: true,
      status: 200,
      body: { id: "local-1", choices: [{ message: { content: "hi" } }], usage: null },
    });
    const local = new OpenAiAdapter({
      apiKey: "",
      baseUrl: "http://127.0.0.1:8080/v1",
      fetchImpl: localFetch as unknown as typeof fetch,
    });
    const response = await local.complete(request());
    expect(response.providerRequestId).toBe("local-1");
    const [, init] = localFetch.mock.calls[0] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("Authorization");
  });
});
