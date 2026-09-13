import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../../src/ui/diff.js";

describe("unified diff", () => {
  it("aligns context, additions and deletions with line numbers", () => {
    const { lines, truncated } = unifiedDiff("a\nb\nc\n", "a\nB\nc\n");
    expect(truncated).toBe(false);
    expect(lines).toEqual([
      { kind: "context", oldNo: 1, newNo: 1, text: "a" },
      { kind: "del", oldNo: 2, newNo: null, text: "b" },
      { kind: "add", oldNo: null, newNo: 2, text: "B" },
      { kind: "context", oldNo: 3, newNo: 3, text: "c" },
      { kind: "context", oldNo: 4, newNo: 4, text: "" },
    ]);
  });

  it("caps output instead of freezing on large previews", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const { lines, truncated } = unifiedDiff(big, `${big}\nappended`, 100);
    expect(truncated).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(100);
  });

  it("refuses quadratic blowup explicitly", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `x${i}`).join("\n");
    const other = Array.from({ length: 2000 }, (_, i) => `y${i}`).join("\n");
    expect(unifiedDiff(big, other).truncated).toBe(true);
  });
});
