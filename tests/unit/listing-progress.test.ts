import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listingProgress } from "../../src/tools/listing-progress.js";

describe("no arbitrary shell equivalence", () => {
  it("declines effectful commands, pipelines, unknown options, and output that is not an observed path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-query-grammar-")); fs.writeFileSync(path.join(root, "a.txt"), "a");
    try {
      for (const command of ["ls -1A; touch x", "find . -delete", "find . -exec touch x ;", "ls -1A | head -n 10", "ls -1A > result", "echo a.txt", "ls $(pwd)", "ls -la"]) expect(listingProgress({ mode: "shell", shell: "sh", command }, root, "a.txt\n", "", { PATH: "/usr/bin:/bin" })).toBeUndefined();
      expect(listingProgress({ mode: "shell", shell: "sh", command: "ls -1A" }, root, "fabricated.txt\n", "", { PATH: "/usr/bin:/bin" })).toBeUndefined();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
