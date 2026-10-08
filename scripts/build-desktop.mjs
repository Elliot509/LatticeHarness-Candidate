// Bundles the Electron main/preload processes with esbuild. The backend
// and UI stay ordinary compiled output; only the desktop shell needs the
// electron import, so it is bundled separately and excluded from tsc.
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outdir = path.join(root, "dist", "desktop");
fs.mkdirSync(outdir, { recursive: true });

for (const entry of ["main.ts", "preload.ts"]) {
  await build({
    entryPoints: [path.join(root, "src", "desktop", entry)],
    bundle: true,
    minify: true,
    format: "cjs",
    platform: "node",
    target: ["node22.13"],
    external: ["electron"],
    outfile: path.join(outdir, entry.replace(/\.ts$/, ".cjs")),
    logLevel: "warning",
  });
}
for (const entry of ["main.cjs", "preload.cjs"]) {
  const from = path.join(outdir, entry);
  const to = path.join(outdir, entry.replace(/\.cjs$/, ".js"));
  if (fs.existsSync(from)) fs.copyFileSync(from, to);
}
process.stdout.write("desktop: bundled to dist/desktop\n");
