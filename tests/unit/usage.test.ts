import { describe, expect, it } from "vitest";
import {
  aggregateRootUsage,
  normalizeUsageQuantities,
  UsageNormalizationError,
} from "../../src/telemetry/usage.js";

describe("usage normalization", () => {
  it("derives inputNew for inclusive providers", () => {
    const usage = normalizeUsageQuantities({
      inputTotal: 1000,
      cacheRead: 400,
      cacheWrite: 0,
      outputTotal: 200,
      inclusiveInput: true,
      source: "adapter-fixture",
    });
    expect(usage.inputTotal).toMatchObject({ value: 1000, quality: "observed" });
    expect(usage.inputNew).toMatchObject({ value: 600, quality: "observed" });
    expect(usage.cacheRead).toMatchObject({ value: 400, quality: "observed" });
  });

  it("accepts exclusive partitions that sum to the total", () => {
    const usage = normalizeUsageQuantities({
      inputTotal: 1100,
      inputNew: 600,
      cacheRead: 400,
      cacheWrite: 100,
      outputTotal: 50,
      inclusiveInput: false,
      source: "adapter-fixture",
    });
    expect(usage.inputTotal.value).toBe(1100);
    expect(usage.inputNew.value).toBe(600);
  });

  it("keeps partitions unknown when only the total is known", () => {
    const usage = normalizeUsageQuantities({
      inputTotal: 1000,
      outputTotal: 10,
      source: "adapter-fixture",
    });
    expect(usage.inputTotal).toMatchObject({ value: 1000, quality: "observed" });
    expect(usage.inputNew).toMatchObject({ value: null, quality: "unknown" });
    expect(usage.cacheRead).toMatchObject({ value: null, quality: "unknown" });
  });

  it("treats observed zero as observed, not unknown", () => {
    const usage = normalizeUsageQuantities({
      inputTotal: 0,
      outputTotal: 0,
      source: "adapter-fixture",
    });
    expect(usage.inputTotal).toMatchObject({ value: 0, quality: "observed" });
    expect(usage.outputTotal).toMatchObject({ value: 0, quality: "observed" });
  });

  it("never double counts a reasoning subset", () => {
    const usage = normalizeUsageQuantities({
      outputTotal: 200,
      reasoningSubset: 50,
      source: "adapter-fixture",
    });
    expect(usage.outputTotal.value).toBe(200);
    expect(usage.reasoningSubset?.value).toBe(50);
    expect(() =>
      normalizeUsageQuantities({
        outputTotal: 200,
        reasoningSubset: 201,
        source: "adapter-fixture",
      }),
    ).toThrow(UsageNormalizationError);
  });

  it("rejects negative values, overflow and inconsistent partitions", () => {
    expect(() =>
      normalizeUsageQuantities({ inputTotal: -1, source: "adapter-fixture" }),
    ).toThrow(UsageNormalizationError);
    expect(() =>
      normalizeUsageQuantities({
        inputTotal: Number.MAX_SAFE_INTEGER + 1,
        source: "adapter-fixture",
      }),
    ).toThrow(UsageNormalizationError);
    expect(() =>
      normalizeUsageQuantities({
        inputTotal: 100,
        inputNew: 90,
        cacheRead: 20,
        cacheWrite: 0,
        inclusiveInput: true,
        source: "adapter-fixture",
      }),
    ).toThrow(UsageNormalizationError);
  });

  it("aggregates root totals without double counting and reports coverage", () => {
    const first = normalizeUsageQuantities({
      inputTotal: 1000,
      cacheRead: 400,
      cacheWrite: 0,
      outputTotal: 200,
      inclusiveInput: true,
      source: "adapter-fixture",
    });
    const second = normalizeUsageQuantities({ source: "adapter-fixture" });
    const totals = aggregateRootUsage([first, second]);
    expect(totals.attempts).toBe(2);
    expect(totals.observed).toBe(1);
    expect(totals.unknown).toBe(1);
    expect(totals.knownInputTotal).toBe(1000);
    expect(totals.knownOutputTotal).toBe(200);
    expect(totals.upperBoundTokens).toBeNull();
  });
});
