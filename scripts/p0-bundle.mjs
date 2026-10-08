// Assembles the P0 desktop bundle outside the source checkout: copies the
// compiled backend/UI/desktop output plus the private Electron runtime into
// one directory that runs with no system Node/npm. Not an installer; the
// P0 proof artifact. Windows and Linux bundles differ only by the Electron
// runtime directory and the launcher script.
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

const root = process.cwd();
const platform = process.env["LATTICE_P0_PLATFORM"] ?? process.platform;
const arch = process.env["LATTICE_P0_ARCH"] ?? process.arch;
const canonicalOut = path.join(root, "dist", "p0-bundle");
const explicitOut = process.env["LATTICE_P0_OUT"];
const outRoot = path.resolve(explicitOut ?? canonicalOut);
const electronDist = path.resolve(process.env["LATTICE_P0_ELECTRON_DIST"] ?? path.join(root, "node_modules", "electron", "dist"));
const electronVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules", "electron", "package.json"), "utf8")).version;
const appEntries = ["cli", "config.js", "context", "desktop", "platform", "productConfig.js", "providers", "runtime", "server", "storage", "telemetry", "tools"];

function fail(message) {
  process.stderr.write(`p0-bundle: ${message}\n`);
  process.exit(1);
}

// Resolve existing ancestors too: a symlinked output parent must not bypass
// protection of the canonical bundle or turn an output into an input tree.
function physicalPath(value) {
  let ancestor = path.resolve(value);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, path.resolve(value)));
}

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function overlaps(a, b) {
  return contains(a, b) || contains(b, a);
}

if (!["linux", "win32"].includes(platform) || arch !== "x64") fail("P0 supports only linux/x64 and win32/x64");
const outputPath = physicalPath(outRoot);
if (fs.lstatSync(outRoot, { throwIfNoEntry: false }) !== undefined) {
  fail("output already exists; choose a new, absent output directory");
}
if ((platform === "win32" || platform !== process.platform) && (!explicitOut || overlaps(outputPath, physicalPath(canonicalOut)))) {
  fail("target output must be explicit and separate from dist/p0-bundle");
}
if (contains(outputPath, physicalPath(root)) || overlaps(outputPath, physicalPath(electronDist))) {
  fail("output must not overlap the source checkout or selected runtime");
}
for (const input of ["package.json", "desktop/package.json", "dist/ui", ...appEntries.map((entry) => path.join("dist", entry))]) {
  if (overlaps(outputPath, physicalPath(path.join(root, input)))) fail(`output overlaps application input ${input}`);
}

const executable = path.join(electronDist, platform === "win32" ? "electron.exe" : "electron");
if (!fs.existsSync(executable) || !fs.existsSync(path.join(electronDist, "version"))) fail("selected runtime is missing its executable or version file");
if (fs.existsSync(path.join(electronDist, platform === "win32" ? "electron" : "electron.exe"))) fail("selected runtime contains the other platform's executable");
if (fs.readFileSync(path.join(electronDist, "version"), "utf8").trim().replace(/^v/, "") !== electronVersion) {
  fail(`selected runtime version does not match pinned Electron ${electronVersion}`);
}

// Check the binary, not its filename; cross-packaging must never relabel ELF
// as Windows or ship a PE for another architecture. No runtime is executed.
const binary = fs.openSync(executable, "r");
try {
  const header = Buffer.alloc(64);
  const bytes = fs.readSync(binary, header, 0, header.length, 0);
  let compatible = false;
  if (platform === "win32" && bytes === 64 && header.toString("ascii", 0, 2) === "MZ") {
    const pe = Buffer.alloc(6);
    compatible = fs.readSync(binary, pe, 0, pe.length, header.readUInt32LE(60)) === pe.length
      && pe.toString("hex", 0, 4) === "50450000" && pe.readUInt16LE(4) === 0x8664;
  } else if (platform === "linux" && bytes === 64) {
    compatible = header.toString("hex", 0, 4) === "7f454c46" && header[4] === 2 && header[5] === 1 && header.readUInt16LE(18) === 62;
  }
  if (!compatible) fail(`selected runtime executable is not ${platform}/${arch}`);
} finally {
  fs.closeSync(binary);
}

for (const required of ["dist/desktop/main.js", "dist/desktop/preload.js", "dist/desktop/backend-entry.js", "dist/ui/index.html", "dist/ui/app.js"]) {
  if (!fs.existsSync(path.join(root, required))) {
    process.stderr.write(`p0-bundle: missing build output ${required}; run npm run build first\n`);
    process.exit(1);
  }
}

const appDir = path.join(outRoot, "app");
fs.mkdirSync(path.join(appDir, "resources"), { recursive: true });

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "*.log") continue;
    if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.ts.map")) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

// Compiled Lattice output only: no TypeScript sources, no dev servers.
for (const entry of appEntries) {
  const from = path.join(root, "dist", entry);
  if (fs.existsSync(from)) {
    const to = path.join(appDir, "resources", "dist", entry);
    if (fs.statSync(from).isDirectory()) copyDir(from, to);
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}
copyDir(path.join(root, "dist", "ui"), path.join(appDir, "resources", "dist", "ui"));
fs.copyFileSync(path.join(root, "package.json"), path.join(appDir, "resources", "package.json"));
fs.copyFileSync(path.join(root, "desktop", "package.json"), path.join(appDir, "package.json"));

// Private Electron runtime: the bundle carries what it needs.
const runtimeDir = path.join(appDir, "runtime");
copyDir(electronDist, runtimeDir);
// Electron resolves the app entry from the app package.json main; point it
// at the bundled desktop shell instead of shipping a second manifest.
const appPkgPath = path.join(appDir, "package.json");
const appPkg = JSON.parse(fs.readFileSync(path.join(root, "desktop", "package.json"), "utf8"));
appPkg.main = "resources/dist/desktop/main.cjs";
appPkg.type = "commonjs";
fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2));
if (platform !== "win32") {
  try {
    fs.chmodSync(path.join(runtimeDir, "electron"), 0o755);
  } catch {
    // Filesystem may not honor modes; the launcher reports launch failures.
  }
  const launcher = `#!/bin/sh\nHERE="$(dirname "$0")"\nexec "$HERE/app/runtime/electron" "$HERE/app" "$@"\n`;
  const launcherPath = path.join(outRoot, "lattice-p0");
  fs.writeFileSync(launcherPath, launcher);
  fs.chmodSync(launcherPath, 0o755);
} else {
  const launcher = `@echo off\r\n"%~dp0app\\runtime\\electron.exe" "%~dp0app" %*\r\n`;
  fs.writeFileSync(path.join(outRoot, "lattice-p0.cmd"), launcher);
  fs.copyFileSync(path.join(root, "desktop", "launchers", "Lattice.vbs"), path.join(outRoot, "Lattice.vbs"));
}

if (platform === "linux") {
  for (const name of ["install-desktop.sh", "install-ubuntu.sh"]) {
    fs.copyFileSync(path.join(root, "desktop", "launchers", name), path.join(outRoot, name));
    fs.chmodSync(path.join(outRoot, name), 0o755);
  }
}
fs.copyFileSync(path.join(root, "desktop", "PORTABLE.md"), path.join(outRoot, "START-HERE.md"));
fs.copyFileSync(path.join(root, "LICENSE"), path.join(outRoot, "LICENSE"));

const manifest = {
  artifact: "lattice-p0-bundle",
  platform,
  arch,
  electron: electronVersion,
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outRoot, "manifest.json"), JSON.stringify(manifest, null, 2));
process.stdout.write(`p0-bundle: wrote ${outRoot} for ${platform}\n`);
