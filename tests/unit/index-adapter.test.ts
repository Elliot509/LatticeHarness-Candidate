import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { adaptExportSnapshot, toClientPayload } from "../../src/index/adapter.js";
import { IncompleteWindowError } from "../../src/index/adapter.js";

function fixture(name: string): string {
  return fs.readFileSync(path.resolve("fixtures/index", name), "utf8");
}

describe("index adapter", () => {
  it("maps input/output/cache per day and model", () => {
    const result = adaptExportSnapshot(fixture("lattice-basic.jsonl"));
    expect(result.days.map((day) => day.date)).toEqual(["2026-09-11", "2026-09-12"]);
    const first = result.days[0]?.models;
    expect(first).toEqual([{ model: "fake-model-1", input: 100, output: 20, cacheRead: 10, cacheWrite: 5 }]);
    const second = result.days[1]?.models;
    expect(second).toContainEqual({ model: "fake-model-1", input: 300, output: 60, cacheRead: 10, cacheWrite: 5 });
    expect(second).toContainEqual({ model: "other-model", input: 300, output: 60, cacheRead: 0, cacheWrite: 0 });
    expect(result.coverage).toMatchObject({ attempts: 4, observed: 4, estimated: 0 });
  });

  it("never adds cache or reasoning into totals", () => {
    const result = adaptExportSnapshot(fixture("lattice-basic.jsonl"));
    // 09-11: input 100 + output 20 = 120; cache (10+5) stays partitioned.
    const payload = toClientPayload(result);
    const day = payload.find((entry) => entry.date === "2026-09-11")?.models[0];
    expect(day).toMatchObject({ input: 100, output: 20, cache_read: 10, cache_write: 5 });
    expect(day?.input).not.toBe(115);
  });

  it("refuses unknown quantities instead of publishing zero", () => {
    expect(() => adaptExportSnapshot(fixture("lattice-unknown.jsonl"))).toThrow(IncompleteWindowError);
    expect(() => adaptExportSnapshot(fixture("lattice-unknown.jsonl"))).toThrow(/unknown/);
  });

  it("refuses provisional snapshots and partial files", () => {
    expect(() => adaptExportSnapshot(fixture("lattice-provisional.jsonl"))).toThrow(/provisional/);
    expect(() => adaptExportSnapshot(fixture("lattice-partial.jsonl"))).toThrow(/terminator|complete/i);
  });

  it("refuses foreign producers", () => {
    expect(() => adaptExportSnapshot(fixture("lattice-foreign.jsonl"))).toThrow(/producer|Lattice/);
  });

  it("attributes the canonical UTC day across midnight", () => {
    const result = adaptExportSnapshot(fixture("lattice-basic.jsonl"));
    // attempt-1 finished 23:59:59Z on the 11th, attempt-2 at 00:00:01Z on the 12th.
    expect(result.days[0]?.models[0]?.input).toBe(100);
    expect(result.days[1]?.models.find((model) => model.model === "fake-model-1")?.input).toBe(300);
  });

  it("emits the client payload shape for direct comparison", () => {
    const result = adaptExportSnapshot(fixture("lattice-basic.jsonl"));
    const payload = toClientPayload(result);
    expect(payload[0]).toEqual({
      date: "2026-09-11",
      models: [{ model: "fake-model-1", input: 100, output: 20, cache_read: 10, cache_write: 5 }],
    });
  });
});
