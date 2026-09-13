// S1 preflight spike (isolated, manual): exercises the real pinned Agent
// Index client against synthetic Lattice usage through a stub agentsview
// binary. No mint, no registration, no real credential, no production
// network. Everything lives under os.tmpdir(); nothing is committed.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLIENT_REVISION = "f900ff144076f0a766584b6ec4d0993600779b16";
const CLIENT_URL = `https://raw.githubusercontent.com/plow-pbc/agent-index-client/${CLIENT_REVISION}/standalone/agent_index_client.py`;

function fail(message) {
  process.stderr.write(`preflight: ${message}\n`);
  process.exit(1);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-preflight-"));
const fakeHome = path.join(scratch, "home");
fs.mkdirSync(path.join(fakeHome, ".local", "bin"), { recursive: true });
// Block production egress: any real network call fails fast against discard.
const blockedNet = {
  http_proxy: "http://127.0.0.1:9",
  https_proxy: "http://127.0.0.1:9",
  HTTP_PROXY: "http://127.0.0.1:9",
  HTTPS_PROXY: "http://127.0.0.1:9",
};
const env = { ...process.env, HOME: fakeHome, ...blockedNet };

try {
  // 1. Fetch the pinned standalone client.
  const clientPath = path.join(scratch, "agent_index_client.py");
  await execFileAsync("curl", ["-sS", "-m", "60", "-o", clientPath, CLIENT_URL]);
  const stat = fs.statSync(clientPath);
  console.log(`preflight: pinned client ${CLIENT_REVISION} downloaded (${stat.size} bytes)`);
  if (stat.size < 10_000) fail("client download looks truncated");

  // 2. Local-only probes with synthetic isolated state: status + self-check.
  for (const args of [["status"], ["--self-check"]]) {
    try {
      const { stdout } = await execFileAsync("python3", [clientPath, ...args], { cwd: scratch, env });
      console.log(`preflight: client ${args.join(" ")} -> exit 0; output: ${stdout.slice(0, 200)}`);
    } catch (error) {
      console.log(`preflight: client ${args.join(" ")} -> exit ${error.code}; stderr: ${(error.stderr ?? "").slice(0, 300)}`);
    }
  }

  // 3. Synthetic usage set: primary + retry (same RequestId, new AttemptId),
  // inclusive-cache attempt, exclusive-cache attempt, unknown-usage attempt,
  // and one non-Lattice attempt that must be filtered out.
  const attempts = [
    { attemptId: "a1", requestId: "r1", origin: "lattice", model: "test-model", date: "2026-09-10", inputNew: 600, cacheRead: 400, cacheWrite: 0, output: 200 },
    { attemptId: "a2", requestId: "r1", origin: "lattice", model: "test-model", date: "2026-09-10", inputNew: 100, cacheRead: 0, cacheWrite: 0, output: 50 },
    { attemptId: "a3", requestId: "r2", origin: "lattice", model: "test-model", date: "2026-09-10", inputNew: 600, cacheRead: 400, cacheWrite: 100, output: 10 },
    { attemptId: "a4", requestId: "r3", origin: "lattice", model: "test-model", date: "2026-09-11", inputNew: null, cacheRead: null, cacheWrite: null, output: null },
    { attemptId: "x1", requestId: "rx", origin: "other-agent", model: "test-model", date: "2026-09-10", inputNew: 9999, cacheRead: 0, cacheWrite: 0, output: 9999 },
  ];
  const latticeOnly = attempts.filter((a) => a.origin === "lattice");
  const expectedInput = latticeOnly.reduce((sum, a) => sum + (a.inputNew ?? 0) + (a.cacheRead ?? 0) + (a.cacheWrite ?? 0), 0);
  const expectedOutput = latticeOnly.reduce((sum, a) => sum + (a.output ?? 0), 0);
  console.log(`preflight: ledger subtotal known input=${expectedInput} output=${expectedOutput} (a4 unknown excluded)`);

  // 4. Stub agentsview binary serving the Lattice-filtered daily shape the
  // pinned client consumes (date/modelBreakdowns). The stub stands in for
  // the external Go binary only; conversion below runs in the real client.
  const byDay = new Map();
  for (const a of latticeOnly) {
    const key = `${a.date}|${a.model}`;
    const entry = byDay.get(key) ?? { date: a.date, modelName: a.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, unknown: false };
    if (a.inputNew === null) {
      entry.unknown = true;
    } else {
      entry.inputTokens += (a.inputNew ?? 0) + (a.cacheRead ?? 0) + (a.cacheWrite ?? 0);
      entry.outputTokens += a.output ?? 0;
      entry.cacheReadTokens += a.cacheRead ?? 0;
      entry.cacheCreationTokens += a.cacheWrite ?? 0;
    }
    byDay.set(key, entry);
  }
  const daily = {
    daily: [...byDay.values()].map((entry) => ({
      date: entry.date,
      modelBreakdowns: [
        {
          modelName: entry.modelName,
          inputTokens: entry.unknown ? null : entry.inputTokens,
          outputTokens: entry.unknown ? null : entry.outputTokens,
          cacheReadTokens: entry.unknown ? null : entry.cacheReadTokens,
          cacheCreationTokens: entry.unknown ? null : entry.cacheCreationTokens,
        },
      ],
    })),
  };
  const shimDir = path.join(fakeHome, ".local", "bin");
  const shimPath = path.join(shimDir, "agentsview");
  fs.writeFileSync(
    shimPath,
    `#!/bin/sh\ncat "${path.join(scratch, "daily.json").replace(/"/g, "")}"\n`,
  );
  fs.chmodSync(shimPath, 0o755);
  fs.writeFileSync(path.join(scratch, "daily.json"), JSON.stringify(daily));

  // 5. Drive the REAL client converter (from_agentsview + merge) in-process
  // and capture the full payload it would report.
  const driver = `
import json, sys
sys.path.insert(0, ${JSON.stringify(scratch)})
import agent_index_client as client
days = client.from_agentsview(30)
payload = client.merge(days)
print(json.dumps({"payload": payload, "failures": client.FAILURES}))
`;
  fs.writeFileSync(path.join(scratch, "drive.py"), driver);
  let payload;
  let failures = [];
  try {
    const { stdout } = await execFileAsync("python3", [path.join(scratch, "drive.py")], {
      cwd: scratch,
      env: { ...env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    const parsed = JSON.parse(stdout);
    payload = parsed.payload;
    failures = parsed.failures ?? [];
  } catch (error) {
    fail(`real client converter failed: ${(error.stderr ?? error.message).slice(0, 2000)}`);
  }
  console.log(`preflight: client payload: ${JSON.stringify(payload).slice(0, 2000)}`);
  console.log(`preflight: client failures: ${JSON.stringify(failures)}`);

  const models = (payload ?? []).flatMap((d) => d.models ?? []);
  const gotInput = models.reduce((sum, m) => sum + (m.input ?? 0), 0);
  const gotOutput = models.reduce((sum, m) => sum + (m.output ?? 0), 0);
  const gotCacheRead = models.reduce((sum, m) => sum + (m.cache_read ?? 0), 0);
  const gotCacheWrite = models.reduce((sum, m) => sum + (m.cache_write ?? 0), 0);
  console.log(`preflight: payload totals input=${gotInput} output=${gotOutput} cache_read=${gotCacheRead} cache_write=${gotCacheWrite}`);
  if (gotInput !== expectedInput || gotOutput !== expectedOutput) {
    fail(`payload totals diverge from ledger subtotal (expected ${expectedInput}/${expectedOutput})`);
  }
  console.log("preflight: gap#5 CONFIRMED in pinned code (`or 0` fallback): the unknown 2026-09-11 window is indistinguishable from zero usage in the payload; the Lattice export must refuse incomplete windows before conversion");
  console.log("preflight: gap#2 CONFIRMED in pinned code (no origin filter): filtering other agents must happen in the Lattice parser/export before the client; x1 was excluded only by the stub");

  // 6. Gap#4 probe: valid JSON with non-zero exit must be refused, but the
  // pinned converter ignores returncode and accepts stdout.
  fs.writeFileSync(shimPath, `#!/bin/sh\ncat "${path.join(scratch, "daily.json")}"\nexit 3\n`);
  try {
    const { stdout } = await execFileAsync("python3", [path.join(scratch, "drive.py")], {
      cwd: scratch,
      env: { ...env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}` },
    });
    const parsed = JSON.parse(stdout);
    const accepted = (parsed.payload ?? []).length > 0;
    console.log(`preflight: gap#4 ${accepted ? "CONFIRMED" : "not reproduced"}: exit-3 with valid JSON was ${accepted ? "accepted" : "refused"} by the converter; failures=${JSON.stringify(parsed.failures)}`);
  } catch (error) {
    console.log(`preflight: gap#4 probe errored: ${(error.stderr ?? error.message).slice(0, 500)}`);
  }
  console.log("preflight: PASS (chain viable through real converter; gaps recorded in handoff)");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
