import { describe, expect, it, vi } from "vitest";
import { OpenAiAdapter } from "../../src/providers/openai.js";
import { listModels } from "../../src/providers/discovery.js";
import { normalizeEndpoint } from "../../src/providers/endpoint.js";

const key = "synthetic-canary-not-a-real-secret";
const request = { model: "fixture", system: "read", messages: [], tools: [] };
describe("provider credential boundary", () => {
  it("rejects credential URLs and nonlocal cleartext before any dispatch", () => {
    for (const url of ["https://user:pass@example.test/v1", "https://example.test/v1?key=x", "https://example.test/v1#key=x"]) expect(() => normalizeEndpoint(url)).toThrow();
    expect(() => new OpenAiAdapter({ apiKey: key, baseUrl: "http://example.test/v1" })).toThrow(/HTTPS/);
  });
  it("does not follow redirects and does not expose provider or network error text", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error(key));
    const adapter = new OpenAiAdapter({ apiKey: key, fetchImpl });
    await expect(adapter.complete(request)).rejects.toThrow("Provider network request failed");
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("error");
    const outcome = await listModels({ apiKey: key, baseUrl: "https://example.test/v1", fetchImpl });
    expect(JSON.stringify(outcome)).not.toContain(key);
    expect(fetchImpl.mock.calls[1]?.[1]?.redirect).toBe("error");
  });
  it("withholds a successful response that reflects the key in text or tool arguments", async () => {
    for (const message of [{ content: key }, { tool_calls: [{ function: { name: "exec", arguments: JSON.stringify({ command: key }) } }] }]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message }] })));
      await expect(new OpenAiAdapter({ apiKey: key, fetchImpl }).complete(request)).rejects.toThrow(/output withheld/);
    }
    const result = await listModels({ apiKey: key, baseUrl: "https://example.test/v1", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: key }] }))) });
    expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain(key);
  });
});
