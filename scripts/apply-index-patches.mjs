// Applies the local Lattice patches onto pinned upstream clones.
// Usage: node scripts/apply-index-patches.mjs <agentsview-dir> <client-dir>
// Idempotent: safe to rerun on an already-patched tree. Exits non-zero when
// a patch does not apply, so CI fails instead of testing unpatched tools.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const patchDir = path.join(here, "index-patches");

function applyGitDiff(repoDir, diffFile) {
  try {
    execFileSync("git", ["apply", "--check", diffFile], { cwd: repoDir, stdio: "pipe" });
  } catch {
    // Already applied (or conflicting): verify by reverse check.
    try {
      execFileSync("git", ["apply", "--reverse", "--check", diffFile], { cwd: repoDir, stdio: "pipe" });
      return;
    } catch {
      throw new Error(`patch does not apply cleanly: ${diffFile}`);
    }
  }
  execFileSync("git", ["apply", diffFile], { cwd: repoDir, stdio: "inherit" });
}

function main() {
  const [agentsviewDir, clientDir] = process.argv.slice(2);
  if (!agentsviewDir || !clientDir) {
    console.error("usage: apply-index-patches.mjs <agentsview-dir> <client-dir>");
    process.exit(1);
  }
  applyGitDiff(agentsviewDir, path.join(patchDir, "agentsview-lattice-provider.diff"));
  for (const file of ["agentsview-lattice.go", "agentsview-lattice-provider.go", "agentsview-lattice_test.go"]) {
    const dest = path.join(agentsviewDir, "internal", "parser", file.replace("agentsview-", ""));
    fs.copyFileSync(path.join(patchDir, file), dest);
  }
  applyGitDiff(clientDir, path.join(patchDir, "agent-index-client-lattice-filter.diff"));
  console.log("index patches applied");
}

main();
