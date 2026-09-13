import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { get } from "node:https";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Managed download of pinned external artifacts: HTTPS from a known origin,
// fixed revision, SHA256 verified before promotion, atomic rename, refuse on
// mismatch, idempotent rerun, no partial promotion, no secret logging, never
// execute before verification.

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadOptions {
  timeoutMs?: number | undefined;
  // Test seam: fetch implementation receiving (url) and returning bytes.
  fetch?: ((url: string) => Promise<Buffer>) | undefined;
}

function defaultFetch(url: string, timeoutMs: number): Promise<Buffer> {
  if (!url.startsWith("https://")) return Promise.reject(new DownloadError(`refusing non-HTTPS artifact URL: ${url}`));
  return new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DownloadError(`download timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
    let settled = false;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof DownloadError ? error : new DownloadError(`download failed: ${error instanceof Error ? error.message : "unknown error"}`));
    };
    try {
      get(url, { timeout: timeoutMs }, (response) => {
        if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
          fail(new DownloadError(`download answered ${response.statusCode ?? "?"}: ${url}`));
          response.resume();
          return;
        }
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
        response.on("error", fail);
      }).on("error", fail);
    } catch (error) {
      fail(error);
    }
  });
}

function rawUrl(repo: string, revision: string, artifactPath: string): string {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/?$/.exec(repo);
  if (match?.[1] === undefined) throw new DownloadError(`artifact origin is not a known github repo: ${repo}`);
  if (!/^[0-9a-f]{7,64}$/.test(revision)) throw new DownloadError("artifact revision must be a hex commit");
  if (artifactPath.startsWith("/") || artifactPath.includes("..")) throw new DownloadError("artifact path escapes the repo");
  return `https://raw.githubusercontent.com/${match[1]}/${revision}/${artifactPath}`;
}

function hashBytes(bytes: Buffer, expected: string): boolean {
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// Downloads repo@revision/artifactPath, verifies SHA256, promotes atomically
// to destPath. Already-correct destination = no-op (idempotent). Throws
// DownloadError on any mismatch or transport failure; never promotes partial.
export async function downloadVerified(options: {
  repo: string;
  revision: string;
  artifactPath: string;
  sha256: string;
  destPath: string;
  timeoutMs?: number | undefined;
  fetch?: ((url: string) => Promise<Buffer>) | undefined;
}): Promise<{ downloaded: boolean }> {
  if (options.sha256 === "") throw new DownloadError("refusing to download without a pinned SHA256");
  const url = rawUrl(options.repo, options.revision, options.artifactPath);
  const destDir = path.dirname(options.destPath);
  fs.mkdirSync(destDir, { recursive: true });
  try {
    const existing = fs.readFileSync(options.destPath);
    if (createHash("sha256").update(existing).digest("hex") === options.sha256) {
      return { downloaded: false };
    }
  } catch {
    // Absent or unreadable: download below.
  }
  const timeoutMs = options.timeoutMs ?? 120000;
  const bytes = await (options.fetch !== undefined ? options.fetch(url) : defaultFetch(url, timeoutMs));
  if (!hashBytes(bytes, options.sha256)) {
    throw new DownloadError(`hash mismatch for ${options.artifactPath}@${options.revision.slice(0, 12)}; refusing to promote`);
  }
  const stamp = `${process.pid}-${Date.now()}`;
  const temporary = path.join(destDir, `.${path.basename(options.destPath)}.${stamp}.new`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, options.destPath);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Cleanup is best effort.
    }
    throw new DownloadError(`cannot promote verified artifact: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  return { downloaded: true };
}

export function pythonCandidates(explicit?: string): string[] {
  if (explicit !== undefined && explicit !== "") return [explicit];
  const names = process.platform === "win32" ? ["python.exe", "python3.exe"] : ["python3"];
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((dir) => dir !== "");
  const found: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        if (fs.existsSync(candidate)) found.push(candidate);
      } catch {
        // Skip unreadable entries.
      }
    }
  }
  return found;
}

// Resolves a usable python3 (>= 3.9, stdlib only needed) without executing
// anything but `--version`. Returns the binary path or null with a reason.
export async function resolvePython(explicit?: string): Promise<{ python: string } | { error: string }> {
  for (const candidate of pythonCandidates(explicit)) {
    try {
      const { stdout, stderr } = await execFileAsync(candidate, ["--version"], { timeout: 15000, windowsHide: true });
      const text = `${stdout} ${stderr}`.trim();
      const match = /Python\s+(\d+)\.(\d+)/.exec(text);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      const major = Number.parseInt(match[1], 10);
      const minor = Number.parseInt(match[2], 10);
      if (major > 3 || (major === 3 && minor >= 9)) return { python: candidate };
    } catch {
      // Unusable candidate: try the next one.
    }
  }
  return { error: "python3 >= 3.9 not found; install Python to use the Agent Index integration (core lattice is unaffected)" };
}

export function platformId(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string {
  return `${platform}-${arch}`;
}

export function toolsDir(dataDir: string): string {
  return path.join(dataDir, "index", "bootstrap", "tools");
}

export function tmpdir(): string {
  return os.tmpdir();
}
