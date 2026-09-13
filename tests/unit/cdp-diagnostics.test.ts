import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findChromium, waitForDebuggerUrl } from "../../tests/browser/cdp.js";

let children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Best effort cleanup.
    }
  }
  children = [];
  delete process.env["CHROMIUM_PATH"];
});

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

describe("chromium discovery", () => {
  it("returns the first candidate that exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-cdp-find-"));
    try {
      const first = path.join(dir, "chrome-a");
      const second = path.join(dir, "chrome-b");
      fs.writeFileSync(first, "x");
      fs.writeFileSync(second, "x");
      expect(findChromium([path.join(dir, "missing"), first, second])).toBe(first);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null when no candidate exists", () => {
    expect(findChromium([path.join(os.tmpdir(), "lattice-cdp-no-such-binary")])).toBeNull();
  });

  it("honors CHROMIUM_PATH over the candidate list", () => {
    process.env["CHROMIUM_PATH"] = process.execPath;
    expect(findChromium([path.join(os.tmpdir(), "lattice-cdp-no-such-binary")])).toBe(process.execPath);
  });
});

describe("chromium startup diagnostics", () => {
  it("rejects with the exit code and captured stderr when the browser dies", async () => {
    const proc = track(
      spawn(process.execPath, ["-e", "console.error('[test] missing shared library marker');process.exit(3);"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    await expect(waitForDebuggerUrl(proc, 5000)).rejects.toThrow(/code=3.*missing shared library marker/s);
  });

  it("rejects with the captured output when no debugger url appears", async () => {
    const proc = track(
      spawn(process.execPath, ["-e", "console.error('warming up marker');setInterval(()=>{},1000);"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    await expect(waitForDebuggerUrl(proc, 300, 300)).rejects.toThrow(/timed out.*warming up marker/s);
  });

  it("extends the wait once for a live browser that prints the url late", async () => {
    const proc = track(
      spawn(process.execPath, ["-e", "console.error('slow init marker');setTimeout(()=>console.error('DevTools listening on ws://127.0.0.1:9/late'),400);setInterval(()=>{},1000);"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    await expect(waitForDebuggerUrl(proc, 200, 2000)).resolves.toBe("ws://127.0.0.1:9/late");
  });

  it("fails fast for a silent live process without granting grace", async () => {
    const proc = track(
      spawn(process.execPath, ["-e", "setInterval(()=>{},1000);"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    const started = Date.now();
    await expect(waitForDebuggerUrl(proc, 300, 10000)).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("resolves the url printed on either stream", async () => {
    const fromStdout = track(
      spawn(process.execPath, ["-e", "console.log('DevTools listening on ws://127.0.0.1:9/one')"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    await expect(waitForDebuggerUrl(fromStdout, 5000)).resolves.toBe("ws://127.0.0.1:9/one");
    const fromStderr = track(
      spawn(process.execPath, ["-e", "console.error('DevTools listening on ws://127.0.0.1:9/two')"], {
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    await expect(waitForDebuggerUrl(fromStderr, 5000)).resolves.toBe("ws://127.0.0.1:9/two");
  });
});
