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
    const adapter = new OpenAiAdapter({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(adapter.adapterRevision).toBe(OPENAI_ADAPTER_REVISION);
    const response = await adapter.complete(request());
    expect(response.toolCalls).toEqual([{ id: "call_1", name: "search", argumentsJson: "{\"kind\":\"text\"}" }]);
    expect(response.usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(response.modelResolved).toBe("gpt-test");
    expect(response.providerRequestId).toBe("chatcmpl-1");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ Authorization: "Bearer k" });
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
    const adapter = new OpenAiAdapter({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await adapter.complete(request());
    expect(response.usage?.cacheReadTokens).toBeUndefined();
    expect(response.usage?.cacheWriteTokens).toBeUndefined();
  });

  it("maps auth, rate limit and server errors without retrying", async () => {
    for (const [status, kind] of [[401, "auth"], [429, "rate-limited"], [500, "server-error"], [400, "invalid-request"]] as const) {
      const fetchImpl = stubFetch({ ok: false, status, body: { error: { message: "nope" } } });
      const adapter = new OpenAiAdapter({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
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
    const adapter = new OpenAiAdapter({ apiKey: "k", fetchImpl: failing as unknown as typeof fetch });
    await expect(adapter.complete(request())).rejects.toMatchObject({ kind: "network" });

    const controller = new AbortController();
    controller.abort();
    const hanging = vi.fn().mockImplementation(((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch);
    const adapter2 = new OpenAiAdapter({ apiKey: "k", fetchImpl: hanging });
    await expect(adapter2.complete({ ...request(), signal: controller.signal })).rejects.toMatchObject({
      kind: "aborted",
    });
  });

  it("rejects responses without choices and omits auth for local endpoints", async () => {
    const fetchImpl = stubFetch({ ok: true, status: 200, body: { choices: [] } });
    const adapter = new OpenAiAdapter({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
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
