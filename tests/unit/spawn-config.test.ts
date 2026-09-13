import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { joinCommand, npmCommand, quoteArg, useShell } from "../../scripts/npm-spawn.mjs";

describe("windows spawn settings", () => {
  it("selects the npm batch shim and a shell on win32", () => {
    expect(npmCommand("win32")).toBe("npm.cmd");
    expect(useShell("win32")).toBe(true);
  });

  it("spawns npm directly without a shell elsewhere", () => {
    for (const platform of ["linux", "darwin"]) {
      expect(npmCommand(platform)).toBe("npm");
      expect(useShell(platform)).toBe(false);
    }
  });

  it("defaults to the current platform", () => {
    expect(npmCommand()).toBe(npmCommand(process.platform));
    expect(useShell()).toBe(useShell(process.platform));
  });
});

describe("shell command quoting", () => {
  it("leaves simple arguments untouched", () => {
    expect(quoteArg("run")).toBe("run");
    expect(quoteArg("--workspace")).toBe("--workspace");
    expect(joinCommand("lattice.cmd", ["run", "--json"])).toBe("lattice.cmd run --json");
  });

  it("quotes arguments carrying spaces or shell metacharacters as one word", () => {
    expect(quoteArg("agent project")).toBe("\"agent project\"");
    expect(quoteArg("console.log(process.argv[1])")).toBe("\"console.log(process.argv[1])\"");
    expect(joinCommand("lattice.cmd", ["run", "--workspace", "C:\\tmp\\agent project"])).toBe(
      "lattice.cmd run --workspace \"C:\\tmp\\agent project\"",
    );
  });

  it("refuses embedded double quotes instead of guessing escaping", () => {
    expect(() => quoteArg("say \"hi\"")).toThrow();
    expect(() => quoteArg("")).toThrow();
  });

  it("keeps spaced paths intact through a shell round trip", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-quote-"));
    try {
      const spaced = path.join(dir, "agent project");
      fs.mkdirSync(spaced);
      const execFileAsync = promisify(execFile);
      const { stdout } = await execFileAsync(
        joinCommand(process.execPath, ["-e", "console.log(process.argv[1])", spaced]),
        { shell: true },
      );
      expect(stdout.trim()).toBe(spaced);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
