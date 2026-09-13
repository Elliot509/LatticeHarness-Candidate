import { describe, expect, it } from "vitest";
import { listModels, testConnection } from "../../src/providers/discovery.js";

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: unknown, init?: unknown) => handler(String(url), (init ?? {}) as RequestInit)) as typeof fetch;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("model discovery", () => {
  it("normalizes an OpenAI-style model list", async () => {
    let seenAuth: string | null = null;
    let seenUrl = "";
    const outcome = await listModels({
      baseUrl: "http://127.0.0.1:8080/v1/",
      apiKey: "k",
      fetchImpl: stubFetch((url, init) => {
        seenUrl = url;
        const headers = new Headers(init.headers as HeadersInit);
        seenAuth = headers.get("authorization");
        return jsonResponse(200, { object: "list", data: [{ id: "m1", owned_by: "local" }, { id: "  " }, { id: "m2", name: "Two" }] });
      }),
    });
    expect(seenUrl).toBe("http://127.0.0.1:8080/v1/models");
    expect(seenAuth).toBe("Bearer k");
    expect(outcome).toEqual({
      ok: true,
      models: [
        { id: "m1", displayName: null, ownedBy: "local" },
        { id: "m2", displayName: "Two", ownedBy: null },
      ],
      source: "models-endpoint",
    });
  });

  it("omits the auth header when no key is configured", async () => {
    let seenAuth: string | null = "unset";
    await listModels({
      baseUrl: "http://127.0.0.1:8080/v1",
      fetchImpl: stubFetch((_url, init) => {
        seenAuth = new Headers(init.headers as HeadersInit).get("authorization");
        return jsonResponse(200, { object: "list", data: [] });
      }),
    });
    expect(seenAuth).toBeNull();
  });

  it("classifies auth, incompatibility, network and partial failures", async () => {
    const auth = await listModels({ baseUrl: "http://x/v1", apiKey: "bad", fetchImpl: stubFetch(() => jsonResponse(401, {})) });
    expect(auth).toEqual({ ok: false, kind: "auth", detail: expect.stringContaining("401") });

    const missing = await listModels({ baseUrl: "http://x/v1", fetchImpl: stubFetch(() => jsonResponse(404, {})) });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.kind).toBe("incompatible");

    const down = await listModels({
      baseUrl: "http://127.0.0.1:9/v1",
      fetchImpl: stubFetch(() => { throw new TypeError("fetch failed"); }),
    });
    expect(down).toEqual({ ok: false, kind: "network", detail: "fetch failed" });

    const partial = await listModels({ baseUrl: "http://x/v1", fetchImpl: stubFetch(() => jsonResponse(200, { object: "list" })) });
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.kind).toBe("partial");

    const empty = await listModels({ baseUrl: "", fetchImpl: stubFetch(() => jsonResponse(200, {})) });
    expect(empty).toEqual({ ok: false, kind: "invalid", detail: "base URL is empty" });
  });

  it("reports timeouts as timeouts, not generic network errors", async () => {
    const outcome = await listModels({
      baseUrl: "http://x/v1",
      timeoutMs: 20,
      fetchImpl: stubFetch((_url, init) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      })),
    });
    expect(outcome).toEqual({ ok: false, kind: "timeout", detail: expect.stringContaining("timed out") });
  });

  it("treats a reachable empty catalog as reachable", async () => {
    const result = await testConnection({
      baseUrl: "http://x/v1",
      fetchImpl: stubFetch(() => jsonResponse(200, { object: "list", data: [] })),
    });
    expect(result).toEqual({ ok: true, kind: "reachable", modelCount: 0, detail: expect.stringContaining("no models") });
  });
});
