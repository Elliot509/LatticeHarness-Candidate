import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Private credential files: temp O_EXCL in the same directory, restrictive
// mode, verify, atomic promote, cleanup on failure. POSIX uses fchmod 0600
// (same semantics as upstream write_private); Windows uses an explicit ACL
// reset (`icacls <file> /inheritance:r /grant:r <user>:F`) so the file is
// really private instead of merely non-readonly. `if windows: skip` is
// never an acceptable fix, so an unverifiable file fails closed here.

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

export function credentialDir(dataDir: string): string {
  return path.join(dataDir, "index", "bootstrap", "credentials");
}

function currentUser(): string {
  const info = os.userInfo({ encoding: "utf8" });
  if (typeof info.username === "string" && info.username !== "") return info.username;
  throw new CredentialError("cannot determine the current user for credential ACLs");
}

async function restrictWindowsAcl(filePath: string): Promise<void> {
  const user = currentUser();
  // icacls.exe directly (NOT via cmd.exe /c): Node spawns the binary with
  // an argv array, so no cmd.exe quote parsing mangles non-ASCII paths.
  // windowsHide keeps it headless; windowsVerbatimArguments is left false
  // so libuv quotes each argument for CreateProcess correctly.
  const args = [filePath, "/inheritance:r", "/grant:r", `${user}:F`];
  try {
    await execFileAsync("icacls.exe", args, { windowsHide: true, timeout: 30000 });
  } catch (error) {
    throw new CredentialError(
      `cannot restrict credential ACLs: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  try {
    const { stdout } = await execFileAsync("icacls.exe", [filePath], { windowsHide: true, timeout: 30000 });
    // /inheritance:r strips inherited entries, but the owner/admin SYSTEM
    // and Administrators grants are intrinsic to the new file, not inherited
    // leaks: verify our user has (F) and no broad identity (Everyone,
    // Users, Authenticated Users, Guests) can read it. Deny entries fail
    // closed too.
    const text = stdout;
    const lower = text.toLowerCase();
    for (const broad of ["everyone:", "\\users:", "authenticated users:", "\\guests:", "deny"]) {
      if (lower.includes(broad)) {
        throw new CredentialError(
          `credential ACL verification failed: broad entry present; icacls said: ${stdout.slice(0, 800)}`,
        );
      }
    }
    const grants = text.split("\n").map((line) => line.trim()).filter((line) => /:[A-Z()]+$/.test(line));
    const mine = grants.filter((line) => line.includes(user) && line.endsWith(":(F)"));
    if (mine.length !== 1) {
      throw new CredentialError(
        `credential ACL verification failed: expected full grant for ${user}; icacls said: ${stdout.slice(0, 800)}`,
      );
    }
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError(
      `cannot verify credential ACLs: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}

function restrictPosixMode(fd: number, filePath: string): void {
  fs.fchmodSync(fd, 0o600);
  const mode = fs.statSync(filePath).mode & 0o777;
  if (mode !== 0o600) {
    throw new CredentialError("refusing to install a credential that is not mode 600");
  }
}

// Writes body to dir/name privately and atomically. Never logs the body,
// never puts it in argv, never leaves a partial file promoted.
export async function writePrivateFile(dir: string, name: string, body: string): Promise<string> {
  if (name.includes("/") || name.includes("\\") || name === "" || name === "." || name === "..") {
    throw new CredentialError("credential name must be a plain filename");
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const destination = path.join(dir, name);
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const temporary = path.join(dir, `.${name}.${stamp}.new`);
  let fd: number;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (error) {
    throw new CredentialError(`cannot create credential temp file: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  try {
    fs.writeFileSync(fd, body, "utf8");
    if (process.platform === "win32") {
      fs.closeSync(fd);
      await restrictWindowsAcl(temporary);
    } else {
      restrictPosixMode(fd, temporary);
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, destination);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed on the Windows path; best effort otherwise.
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Cleanup is best effort; the error below stays actionable.
    }
    if (error instanceof CredentialError) throw error;
    throw new CredentialError(`cannot install credential file: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return destination;
}
