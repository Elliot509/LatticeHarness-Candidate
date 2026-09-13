import { describe, expect, it } from "vitest";
import {
  compileSurface,
  ContextOverflowError,
  KERNEL,
  type TaskSurface,
} from "../../src/context/compiler.js";

function task(): TaskSurface {
  return {
    objective: "Fix the off-by-one",
    acceptanceCriteria: ["relevant test passes"],
    grants: ["read, edit under workspace"],
    prohibitions: ["publish"],
    obligations: ["preserve baseline"],
    unknowns: [],
    humanDecisions: [],
    versions: ["src/a.ts@abc"],
    lastError: null,
  };
}

describe("context compiler", () => {
  it("always includes every anchor in the surface", () => {
    const surface = compileSurface(task(), [], { maxChars: 100_000 });
    for (const anchor of [
      "Fix the off-by-one",
      "relevant test passes",
      "read, edit under workspace",
      "publish",
      "preserve baseline",
      "src/a.ts@abc",
    ]) {
      expect(surface.task).toContain(anchor);
    }
    expect(surface.system).toBe(KERNEL);
    expect(surface.anchorCount).toBe(8);
  });

  it("includes the discriminating error and unknowns when present", () => {
    const surface = compileSurface(
      { ...task(), unknowns: ["edit receipt pending"], lastError: "test failed: expected 2 got 3" },
      [],
      { maxChars: 100_000 },
    );
    expect(surface.task).toContain("edit receipt pending");
    expect(surface.task).toContain("expected 2 got 3");
    expect(surface.anchorCount).toBe(9);
  });

  it("drops oldest evidence first and names what was omitted", () => {
    const evidence = [
      { id: "keep", text: "x".repeat(10) },
      { id: "drop1", text: "y".repeat(5000) },
      { id: "drop2", text: "z".repeat(5000) },
    ];
    const surface = compileSurface(task(), evidence, { maxChars: 2000 });
    expect(surface.evidenceIncluded).toBeLessThan(3);
    expect(surface.evidenceOmitted).toBeGreaterThan(0);
    expect(surface.task).toContain("omitidos por limite");
    for (const id of surface.omittedIds) {
      expect(surface.task).toContain(id);
    }
    expect(surface.task).toContain("[keep]");
  });

  it("refuses to call the model when anchors alone overflow", () => {
    expect(() => compileSurface(task(), [], { maxChars: 10 })).toThrow(ContextOverflowError);
    try {
      compileSurface(task(), [], { maxChars: 10 });
      expect.unreachable();
    } catch (error) {
      expect((error as ContextOverflowError).message).toContain("obligations omitted");
    }
  });
});
