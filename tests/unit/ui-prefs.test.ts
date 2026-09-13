import { describe, expect, it } from "vitest";
import {
  loadModelDefaults,
  sendOnEnterEnabled,
  setSendOnEnter,
  type StringStore,
} from "../../src/ui/views.js";

function memoryStore(entries: Record<string, string> = {}): StringStore {
  const data = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

describe("ui preferences", () => {
  it("keeps Enter-to-send enabled by default and persists an explicit choice", () => {
    expect(sendOnEnterEnabled(memoryStore())).toBe(true);
    const store = memoryStore();
    setSendOnEnter(false, store);
    expect(store.getItem("lattice.sendOnEnter")).toBe("0");
    expect(sendOnEnterEnabled(store)).toBe(false);
    setSendOnEnter(true, store);
    expect(store.getItem("lattice.sendOnEnter")).toBe("1");
    expect(sendOnEnterEnabled(store)).toBe(true);
  });

  it("falls back to sending with Enter when storage is unavailable", () => {
    expect(sendOnEnterEnabled(null)).toBe(true);
    expect(() => { setSendOnEnter(false, null); }).not.toThrow();
  });

  it("loads empty model defaults without a browser store", () => {
    expect(loadModelDefaults()).toEqual({ model: "", baseUrl: "http://127.0.0.1:8080/v1" });
  });
});
