// Smoke an existing bundle outside the checkout. The explicitly invoked
// owner receives an ephemeral session through an inherited anonymous pipe;
// HTTP bootstrap remains private and no token reaches stdout or a file.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const bundle = process.argv[2] ?? path.join(process.cwd(), "dist", "p0-bundle");
const launcher = process.platform === "win32" ? path.join(bundle, "lattice-p0.cmd") : path.join(bundle, "lattice-p0");
if (!fs.existsSync(launcher)) throw new Error(`p0-smoke: launcher missing: ${launcher}`);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-p0-smoke-"));
const workspace = path.join(scratch, "ws");
const dataDir = path.join(scratch, "data dir", "café");
fs.mkdirSync(workspace, { recursive: true });
const cleanEnv = { ...process.env };
delete cleanEnv["NODE"]; delete cleanEnv["NODE_PATH"]; delete cleanEnv["LATTICE_API_KEY"];
cleanEnv["PATH"] = process.platform === "win32" ? "C:\\Windows\\System32;C:\\Windows" : "/usr/bin:/bin";
if (process.platform !== "win32") {
  // The launcher needs dirname, but app startup must not fall back to a
  // developer Node/npm found in /usr/bin. Provide only that shell utility.
  const cleanPath = path.join(scratch, "launcher-tools");
  fs.mkdirSync(cleanPath);
  fs.symlinkSync("/usr/bin/dirname", path.join(cleanPath, "dirname"));
  cleanEnv["PATH"] = cleanPath;
}
cleanEnv["LATTICE_DESKTOP_WORKSPACE"] = workspace;
cleanEnv["LATTICE_DESKTOP_DATA_DIR"] = dataDir;
cleanEnv["LATTICE_P0_SMOKE"] = "1";
cleanEnv["LATTICE_P0_OWNER_PIPE"] = "1";
const child = process.platform === "win32"
  ? spawn("cmd", ["/d", "/s", "/c", launcher, "--p0-smoke"], { env: cleanEnv, stdio: ["ignore", "pipe", "pipe", "pipe"] })
  : spawn(launcher, ["--p0-smoke"], { env: cleanEnv, stdio: ["ignore", "pipe", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", chunk => { output = (output + chunk.toString("utf8")).slice(-4000); });
child.stderr.on("data", chunk => { output = (output + chunk.toString("utf8")).slice(-4000); });
let url;
try {
  const ready = await new Promise((resolve, reject) => {
    let privateMessage = "";
    const timer = setTimeout(() => reject(new Error("private owner handshake timed out")), 45000);
    child.stdio[3].on("data", chunk => {
      privateMessage += chunk.toString("utf8");
      if (privateMessage.length > 4096) { clearTimeout(timer); reject(new Error("owner handshake too large")); return; }
      if (!privateMessage.includes("\n")) return;
      clearTimeout(timer);
      try { resolve(JSON.parse(privateMessage)); } catch { reject(new Error("malformed owner handshake")); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`desktop exited early (${code}); ${output}`)); });
  });
  url = ready.url;
  const cookie = ready.cookie;
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url) || typeof cookie !== "string" || cookie === "") throw new Error("invalid owner handshake");
  const noBootstrap = await fetch(`${url}/`);
  if (noBootstrap.status !== 401 || noBootstrap.headers.has("set-cookie")) throw new Error("private bootstrap exposed over HTTP");
  const home = await fetch(`${url}/`, { headers: { Cookie: cookie } });
  if (home.status !== 200 || !(await home.text()).includes("/assets/app.js")) throw new Error("production UI missing");
  if ((await fetch(`${url}/assets/app.js`)).status !== 200) throw new Error("compiled UI missing");
  if ((await fetch(`${url}/api/sessions`)).status !== 401) throw new Error("API accepted unauthenticated request");
  const created = await (await fetch(`${url}/api/commands`, {
    method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ commandId: "p0-smoke-1", kind: "create-task", payload: { workspace: "", objective: "P0 smoke task", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" } }),
  })).json();
  if (created.accepted !== true) throw new Error("create-task denied");
  const snapshot = await (await fetch(`${url}/api/tasks/${created.taskId}/snapshot`, { headers: { Cookie: cookie } })).json();
  if (snapshot.objective !== "P0 smoke task" || snapshot.state !== "READY") throw new Error("incorrect retained task snapshot");
  const events = await fetch(`${url}/api/tasks/${created.taskId}/events`, { headers: { Cookie: cookie, Accept: "text/event-stream" } });
  if (events.status !== 200 || !(events.headers.get("content-type") ?? "").includes("text/event-stream")) throw new Error("SSE failed");
  await events.body?.cancel();
  const again = await (await fetch(`${url}/api/tasks/${created.taskId}/snapshot`, { headers: { Cookie: cookie } })).json();
  if (again.taskId !== created.taskId || !fs.existsSync(path.join(dataDir, "lattice.db"))) throw new Error("retained SQLite history missing");
  process.stdout.write("p0-smoke: production UI, private auth, HTTP, SSE and SQLite passed\n");
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("normal desktop shutdown timed out")); }, 10000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  fs.rmSync(scratch, { recursive: true, force: true });
}
if (child.exitCode !== 0) throw new Error(`desktop shutdown was not clean (${child.exitCode})`);
let backendGone = false;
try { await fetch(`${url}/`); } catch { backendGone = true; }
if (!backendGone) throw new Error("backend listener survived shutdown");
process.stdout.write("p0-smoke: PASS (normal exit 0; backend listener closed)\n");
