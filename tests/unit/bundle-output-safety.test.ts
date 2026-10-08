import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it.each(["directory", "symlink"])("refuses an existing %s output without deleting its contents", kind => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-bundle-guard-"));
  try {
    const old = path.join(scratch, "old"); fs.mkdirSync(old); fs.writeFileSync(path.join(old, "keep.txt"), "preserve");
    const output = kind === "directory" ? old : path.join(scratch, "link");
    if (kind === "symlink") fs.symlinkSync(old, output, "junction");
    const run = spawnSync(process.execPath, ["scripts/p0-bundle.mjs"], { env: { ...process.env, LATTICE_P0_OUT: output }, encoding: "utf8" });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("output already exists");
    expect(fs.readFileSync(path.join(old, "keep.txt"), "utf8")).toBe("preserve");
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
