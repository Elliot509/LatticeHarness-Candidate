export interface DiffLine {
  kind: "context" | "add" | "del";
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

// Minimal line diff for evidence previews: longest-common-subsequence on
// lines, capped so large previews never freeze the DOM. This renders what
// the receipts retained, never a reconstruction of unretained bytes.
export function unifiedDiff(before: string, after: string, maxLines = 400): { lines: DiffLine[]; truncated: boolean } {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 250_000) {
    return { lines: [], truncated: true };
  }
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      const ai = a[i] ?? "";
      const bj = b[j] ?? "";
      dp[i] = dp[i] ?? [];
      const row = dp[i] as number[];
      const down = dp[i + 1]?.[j] ?? 0;
      const right = row[j + 1] ?? 0;
      row[j] = ai === bj ? (dp[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(down, right);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  let oldNo = 1;
  let newNo = 1;
  while (i < m && j < n) {
    if (lines.length >= maxLines) return { lines, truncated: true };
    const ai = a[i] ?? "";
    const bj = b[j] ?? "";
    if (ai === bj) {
      lines.push({ kind: "context", oldNo, newNo, text: ai });
      i += 1;
      j += 1;
      oldNo += 1;
      newNo += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: "del", oldNo, newNo: null, text: ai });
      i += 1;
      oldNo += 1;
    } else {
      lines.push({ kind: "add", oldNo: null, newNo, text: bj });
      j += 1;
      newNo += 1;
    }
  }
  while (i < m) {
    if (lines.length >= maxLines) return { lines, truncated: true };
    lines.push({ kind: "del", oldNo, newNo: null, text: a[i] ?? "" });
    i += 1;
    oldNo += 1;
  }
  while (j < n) {
    if (lines.length >= maxLines) return { lines, truncated: true };
    lines.push({ kind: "add", oldNo: null, newNo, text: b[j] ?? "" });
    j += 1;
    newNo += 1;
  }
  return { lines, truncated: false };
}
