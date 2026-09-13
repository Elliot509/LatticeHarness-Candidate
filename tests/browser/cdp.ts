import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STARTUP_TIMEOUT_MS = 15000;
// One bounded extension while a started-but-slow browser keeps initializing
// (observed on loaded CI hosts: alive, emitting init output, DevTools late).
// Dead or silent processes still fail fast at the base timeout.
const STARTUP_PROGRESS_GRACE_MS = 30000;

// GitHub ubuntu runners ship google-chrome as a native deb and also expose it
// via CHROME_BIN, while /usr/bin/chromium points at a raw snapshot build
// without installed-dependency guarantees. Prefer the deb-installed browser;
// the snapshot stays as a fallback for machines that only have it.
const DEFAULT_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

function defaultCandidates(): string[] {
  const fromEnv = process.env["CHROME_BIN"];
  if (fromEnv !== undefined && fromEnv !== "" && !DEFAULT_CANDIDATES.includes(fromEnv)) {
    return [fromEnv, ...DEFAULT_CANDIDATES];
  }
  return [...DEFAULT_CANDIDATES];
}

export function findChromium(candidates: string[] = defaultCandidates()): string | null {
  const override = process.env["CHROMIUM_PATH"];
  if (override !== undefined && override !== "" && fs.existsSync(override)) return override;
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export class CdpSession {
  private socket: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  readonly ready: Promise<void>;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.ready = new Promise<void>((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("cdp socket failed")), { once: true });
    });
    this.socket.addEventListener("message", (event: MessageEvent) => {
      const data = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: unknown };
      if (data.id === undefined) return;
      const pending = this.pending.get(data.id);
      if (pending === undefined) return;
      this.pending.delete(data.id);
      if (data.error !== undefined) pending.reject(new Error(`cdp: ${JSON.stringify(data.error)}`));
      else pending.resolve(data.result ?? {});
    });
  }

  async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.ready;
    const id = this.nextId++;
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
    return result as T;
  }

  close(): void {
    this.socket.close();
  }
}

export interface ChromiumInstance {
  proc: ChildProcess;
  session: CdpSession;
  close(): Promise<void>;
}

// Waits for the browser to print its DevTools endpoint on either output
// stream. Startup crashes used to surface as a bare timeout because stderr
// was discarded; every rejection below carries the observed exit state plus
// the captured output tail so the next CI log names the cause. A browser
// that already exited (or never printed anything) fails at the base
// timeout; one that is alive with init output gets a single bounded grace
// period, then fails the same way. Total wait stays capped, never a loop.
export function waitForDebuggerUrl(proc: ChildProcess, timeoutMs: number, graceMs: number = STARTUP_PROGRESS_GRACE_MS): Promise<string> {
  let output = "";
  let extended = false;
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const describeState = (): string =>
      `(exit=${proc.exitCode ?? "?"} signal=${proc.signalCode ?? "?"}); output tail: ${tail(output)}`;
    const arm = (ms: number): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        const alive = proc.exitCode === null && proc.signalCode === null;
        if (!extended && alive && output !== "") {
          extended = true;
          arm(graceMs);
          return;
        }
        settled = true;
        clearTimeout(timer);
        proc.kill("SIGKILL");
        reject(
          new Error(`chromium startup timed out after ${timeoutMs}ms without a debugger url ${describeState()}`),
        );
      }, ms);
    };
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      output += chunk.toString("utf8");
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(output);
      if (match?.[1] !== undefined) {
        const url = match[1];
        settle(() => resolve(url));
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.once("error", (error) => {
      settle(() => {
        clearTimeout(timer);
        proc.kill("SIGKILL");
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    proc.once("exit", (code, signal) => {
      settle(() => {
        clearTimeout(timer);
        reject(
          new Error(
            `chromium exited during startup (code=${code ?? "?"} signal=${signal ?? "?"}); output: ${tail(output) || "<empty>"}`,
          ),
        );
      });
    });
    arm(timeoutMs);
  });
}

function tail(text: string, limit = 2000): string {
  return text.length > limit ? text.slice(-limit) : text;
}

export async function launchChromium(debugPort: number): Promise<ChromiumInstance> {
  const binary = findChromium();
  if (binary === null) throw new Error("no chromium binary found");
  // Fresh profile per launch: avoids Singleton locks left behind by killed
  // runs and runner HOME quirks; removed on close and on startup failure.
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-chrome-profile-"));
  const proc = spawn(
    binary,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const cleanupProfile = (): void => {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // Best effort: a killed browser may briefly hold profile locks.
    }
  };
  let wsUrl: string;
  try {
    wsUrl = await waitForDebuggerUrl(proc, STARTUP_TIMEOUT_MS);
  } catch (error) {
    proc.kill("SIGKILL");
    cleanupProfile();
    throw error;
  }
  const opened = (await openPage(debugPort)) as { webSocketDebuggerUrl?: string };
  const pageUrl =
    opened.webSocketDebuggerUrl ??
    ((await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Array<{ webSocketDebuggerUrl?: string }>).find(
      (target) => target.webSocketDebuggerUrl !== undefined,
    )?.webSocketDebuggerUrl;
  if (pageUrl === undefined) throw new Error("no debuggable page target");
  const session = new CdpSession(pageUrl);
  await session.ready;
  void wsUrl;
  return {
    proc,
    session,
    close: async () => {
      session.close();
      proc.kill("SIGKILL");
      cleanupProfile();
    },
  };
}

async function openPage(debugPort: number): Promise<unknown> {
  let lastError = "";
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" });
      const text = await response.text();
      return JSON.parse(text) as unknown;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "unknown error";
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`could not open a debuggable page: ${lastError}`);
}

export async function screenshot(
  session: CdpSession,
  path: string,
): Promise<void> {
  const result = await session.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path, Buffer.from(result.data, "base64"));
}
