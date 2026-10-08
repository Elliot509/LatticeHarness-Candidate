import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveInScope } from "../platform/paths.js";
import type { ToolResult } from "../tools/types.js";
import { VerifyLedger, summarizeExecResult } from "./verify.js";

export type AcceptancePredicate =
  | { kind: "directory-exists" | "file-exists"; path: string }
  | { kind: "tests-pass" | "response" };

export function defaultAcceptance(objective: string): string[] {
  // Only narrow, explicit requests acquire a filesystem predicate. Ambiguous
  // objectives keep the coding verifier or a response criterion, never an
  // inferred arbitrary shell command or a model-generated success oracle.
  const simpleObjective = objective.trim().replace(/\s+(?:neste|nesse|no)\s+projeto[.!]?$/iu, "");
  const named = /(pasta|diret[oó]rio|directory|folder|arquivo|file)\s+(?:(?:dentro.*?\s+)?(?:que\s+tenha\s+o\s+)?nome\s+(?:de\s+)?|(?:chamad[ao]|named|called)\s+|(?:com\s+o\s+nome\s+)?)["'`]?([^\s"'`<>]+)["'`]?\s*[.!]?$/iu.exec(simpleObjective);
  const singleCreation = /^(?:por favor[, ]+)?(?:cri[ea]|criar|create|mkdir)\b/iu.test(objective.trim()) && !/(?:[;\n]|\s(?:and|e|tamb[eé]m|also)\s)/iu.test(objective);
  if (singleCreation && named?.[2]) return [`${/^(?:arquivo|file)$/iu.test(named[1] ?? "") ? "file" : "directory"}-exists:${named[2].replace(/[.!]$/, "")}`];
  if (/\b(expli(?:que|car)|explain|anal[yi]s[ei]|resuma|summari[sz]e|inspect|inspecione|read|leia|diagn[oó]stico)\b/iu.test(objective)) return ["response"];
  return ["tests-pass"];
}

function predicate(text: string): AcceptancePredicate | null {
  const match = /^(directory-exists|file-exists):(.+)$/u.exec(text);
  if (match?.[1] && match[2]) return { kind: match[1] as "directory-exists" | "file-exists", path: match[2] };
  if (text === "response") return { kind: "response" };
  if (text === "tests-pass" || /^(?:project test suite passes|tests pass|task completed as verified)$/iu.test(text)) return { kind: "tests-pass" };
  return null;
}

export interface WorkspaceSnapshot {
  version: string | null;
  reason: string;
  entries: Map<string, string>;
  bytesRead: number;
  durationMs: number;
}

export function sameObservedFile(before: Pick<fs.BigIntStats, "ino" | "dev">, opened: Pick<fs.BigIntStats, "ino" | "dev">, platform: NodeJS.Platform = process.platform): boolean {
  // Node 22 on Windows can report path-stat dev=0 but handle-stat the
  // volume serial. Keep the nonzero file ID check; do not ignore a known
  // device mismatch or apply this exception to POSIX.
  return before.ino === opened.ino && before.ino !== 0n
    && (before.dev === opened.dev || (platform === "win32" && before.dev === 0n));
}

// Content evidence only at verification boundaries, never per read/search.
// Coverage deliberately excludes generated/dependency directories. Symlink
// destinations outside this tree and the test runner's environment are not
// certified. This is an observation, not an atomic filesystem snapshot.
export async function workspaceVersion(root: string, options: { signal?: AbortSignal; maxDurationMs?: number } = {}): Promise<WorkspaceSnapshot> {
  const hash = createHash("sha256");
  const entries = new Map<string, string>();
  const started = performance.now();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = 0;
  const guard = (): void => {
    if (options.signal?.aborted === true) throw new Error("verification cancelled");
    if (performance.now() - started >= (options.maxDurationMs ?? 30_000)) throw new Error("content observation deadline exceeded; retry in a quiet, bounded project");
  };
  const walk = async (dir: string): Promise<void> => {
    guard();
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const item of items) {
      guard();
      if ([".git", "node_modules", "dist", ".cache"].includes(item.name)) continue;
      const full = path.join(dir, item.name);
      const relative = path.relative(root, full);
      const before = await fs.promises.lstat(full, { bigint: true });
      let record: unknown[];
      if (before.isSymbolicLink()) record = [relative, "symlink", await fs.promises.readlink(full)];
      else if (before.isDirectory()) record = [relative, "directory", String(before.mode)];
      else if (before.isFile()) {
        const content = createHash("sha256");
        // Open without following a swapped symlink; use the same descriptor
        // for identity and streaming, then check the path still names it.
        const file = await fs.promises.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = await file.stat({ bigint: true });
          if (!sameObservedFile(before, opened) || !opened.isFile()) throw new Error("file changed during content observation");
          for (;;) {
            guard();
            const { bytesRead: count } = await file.read(buffer, 0, buffer.length, null);
            if (count === 0) break;
            content.update(buffer.subarray(0, count));
            bytesRead += count;
          }
        } finally { await file.close(); }
        record = [relative, "file", String(before.mode), String(before.size), content.digest("hex")];
      } else throw new Error("unsupported filesystem entry; content evidence unknown");
      const after = await fs.promises.lstat(full, { bigint: true });
      if (["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new Error("entry changed during content observation");
      const encoded = JSON.stringify(record);
      hash.update(encoded).update("\n"); // JSON escaping frames paths/types/content unambiguously.
      entries.set(relative, encoded);
      if (before.isDirectory()) await walk(full);
    }
  };
  try {
    await walk(root);
    return { version: hash.digest("hex"), reason: "content observed", entries, bytesRead, durationMs: performance.now() - started };
  } catch (error) {
    const known = error instanceof Error && /^(verification cancelled|content observation deadline|file changed|entry changed|unsupported filesystem)/u.test(error.message);
    return { version: null, reason: known ? error.message : "workspace content observation incomplete (unreadable or changing entry)", entries, bytesRead, durationMs: performance.now() - started };
  }
}

export class TaskAcceptance {
  private readonly ledger = new VerifyLedger();
  private prepared: WorkspaceSnapshot | null = null;
  private tested: WorkspaceSnapshot | null = null;
  private unknownReason = "test evidence requires a content observation before execution";
  private signal: AbortSignal | undefined;
  private mutated = false;
  private readonly checks: Array<AcceptancePredicate | null>;
  private readonly root: string;
  private readonly criteria: readonly string[];

  constructor(root: string, criteria: readonly string[]) {
    this.root = root;
    this.criteria = criteria;
    this.checks = criteria.map(predicate);
  }

  async prepare(tool: string, signal?: AbortSignal): Promise<void> {
    this.signal = signal;
    if (tool === "exec" && this.checks.some(check => check?.kind === "tests-pass" || check?.kind === "response")) {
      this.prepared = await workspaceVersion(this.root, signal === undefined ? {} : { signal });
    }
  }

  async observe(tool: string, argsJson: string, result: ToolResult): Promise<void> {
    if (tool === "edit" && result.errorKind === undefined) { this.mutated = true; this.tested = null; }
    if (tool !== "exec") return;
    if (result.errorKind !== "invalid-args") { this.mutated = true; this.tested = null; }
    const summary = summarizeExecResult(argsJson, this.root, result, 0);
    if (summary.countsKnown) {
      this.ledger.record(summary);
      if (this.ledger.check().complete && result.effectUncertain !== true && result.status === "completed") {
        const after = await workspaceVersion(this.root, this.signal === undefined ? {} : { signal: this.signal });
        this.unknownReason = this.prepared?.version === null ? this.prepared.reason : after.version === null ? after.reason : "workspace changed while tests ran; rerun tests after changes settle";
        if (this.prepared?.version !== null && this.prepared?.version !== undefined && after.version === this.prepared.version) this.tested = after;
      }
    }
    this.prepared = null;
  }

  get hasFilesystemPredicate(): boolean { return this.checks.some((check) => check?.kind === "directory-exists" || check?.kind === "file-exists"); }

  async check(finalText?: string): Promise<{ complete: boolean; reason: string }> {
    const observed: string[] = [];
    let current: WorkspaceSnapshot | null = null;
    for (const [index, check] of this.checks.entries()) {
      if (check === null) return { complete: false, reason: `criterion needs an explicit verifier: ${this.criteria[index]}` };
      if (check.kind === "directory-exists" || check.kind === "file-exists") {
        const target = resolveInScope(this.root, check.path);
        if (target === null) return { complete: false, reason: `acceptance target escapes the workspace: ${check.path}` };
        try {
          const stat = fs.statSync(target);
          if (!(check.kind === "directory-exists" ? stat.isDirectory() : stat.isFile())) throw new Error("wrong kind");
          observed.push(`${check.kind}:${check.path} observed on filesystem`);
        } catch { return { complete: false, reason: `${check.kind}:${check.path} not observed` }; }
      } else if (check.kind === "tests-pass" || this.mutated) {
        const tests = this.ledger.check();
        if (!tests.complete) return tests;
        if (this.tested === null) return { complete: false, reason: `test evidence unknown or stale: ${this.unknownReason}` };
        current ??= await workspaceVersion(this.root, this.signal === undefined ? {} : { signal: this.signal });
        if (current.version === null) return { complete: false, reason: `test evidence unknown: ${current.reason}` };
        if (current.version !== this.tested.version) {
          const changed = [...new Set([...current.entries.keys(), ...this.tested.entries.keys()])].find(key => current?.entries.get(key) !== this.tested?.entries.get(key));
          return { complete: false, reason: `test evidence is stale: observed content changed (${changed ?? "workspace"}); rerun tests` };
        }
        observed.push(tests.reason);
      } else {
        if (finalText === undefined || finalText.trim() === "") return { complete: false, reason: "final analysis response required" };
        observed.push("analysis response provided; filesystem correctness not certified");
      }
    }
    return { complete: observed.length > 0, reason: observed.join("; ") || "no acceptance criteria" };
  }
}
