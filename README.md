# Lattice

Lattice is a local-first agent harness runtime. You point it at a project
directory, configure a model provider, and it runs one coding task at a time
through a durable loop: it searches, reads, edits and executes commands in
your workspace, verifies the result against criteria you set, and persists
every decision so interrupted work can be resumed instead of replayed.

No performance claims are made here. What follows describes the current
0.0.0 prerelease exactly as implemented.

## What it does

- Runs one agentic coding task per invocation (`lattice run`) with a bounded
  iteration budget and explicit acceptance criteria.
- Gives the agent five versioned tools: `search`, `read`, `edit`, `exec` and
  `process` (long-running commands with poll/send/stop handles).
- Enforces authority before effects: task contract, grants, reservations and
  receipts are committed to a local SQLite database; uncertain attempts stay
  `UNKNOWN` until reconciled, never silently retried.
- Verifies outcomes: a verification command you supply (e.g. your test
  suite) gates completion; exit zero alone is not proof.
- Resumes safely: `sessions` / `resume` / `run --resume` continue under the
  original session and budget after interruption or restart.
- Supports minimal waiting: owned processes, human input and deadlines while
  the app is alive; explicit `wake` delivery with durable dedup.
- Serves a local web UI on loopback for observing tasks, steering them and
  configuring providers, with session-cookie auth and origin checks.
- Writes a local JSONL usage snapshot per session (`export`); optional,
  opt-in usage reporting to the Agent Index is fully separate (see below).

## Requirements

- **Node.js >= 22.13.0** (uses the built-in `node:sqlite`; no native build
  step, no postinstall compile).
- **npm** (ships with Node) for installation.
- Not required for normal core use: Docker, Python, Git, a browser (the CLI
  is fully functional headless), or any account. Python and two external
  helper tools are needed only for the optional Agent Index reporting path.

## Installation

The package identity is `lattice-harness` (binary: `lattice`). Version
`0.0.0` has **not been published to the npm registry yet**, so the registry
command below applies only after publication.

After npm publication (preferred public route):

```sh
npm install -g lattice-harness
lattice status
```

Until then, install the current tarball or source (developer route):

```sh
npm pack            # produces lattice-harness-0.0.0.tgz in this directory
npm install -g ./lattice-harness-0.0.0.tgz
lattice status
```

Or run from a source checkout without installing:

```sh
npm ci
npm run build
node dist/cli/main.js status
```

All three routes ship the same runtime: compiled `dist/`, the `lattice`
binary, this README and the MIT LICENSE. Sources, tests and fixtures are
excluded from the tarball.

## Quick Start

Shortest verified path from install to a first task. The `status` lines
below are illustrative excerpts of the human-readable output:

```sh
lattice status
# provider: pending configuration (set LATTICE_PROVIDER and LATTICE_MODEL)

export LATTICE_PROVIDER=openai
export LATTICE_MODEL="<model-id>"
export LATTICE_API_KEY="<your-key>"   # openai preset only; never commit it

lattice status
# status: ready

cd /path/to/your/project
lattice run --task "Fix the failing test in <area>" \
  --accept "project test suite passes" \
  --provider openai --model "<model-id>" \
  --verify <test-executable> [--verify-arg <arg> ...]
```

Exit codes of `run`: `0` verified STOP, `2` ASK (needs input), `3` ESCALATE
(blocked), `4` stable WAIT (keep the app alive for a wake), `1` error.

Then, in the same project directory, `lattice` opens the desktop/web UI for
observing and steering the work.

## Provider configuration

Every supported provider speaks OpenAI-compatible Chat Completions through a
single adapter. Presets (ids for `--provider`): `openai`, `openrouter`,
`gemini`, `abacus`, `local`, `custom`.

- Readiness: `LATTICE_PROVIDER` and `LATTICE_MODEL` set the default
  provider/model pair reported by `lattice status` (`ready` vs
  `provider-pending`).
- API keys: the `openai` preset reads `LATTICE_API_KEY` from the
  environment. The key is never printed or logged. Other presets are given
  keys per-session in the UI (held in server memory only, never persisted,
  never sent to the browser as values).
- Per-run selection: `lattice run --provider <id> --model <id>
  [--base-url <url>]`. Over the CLI, non-OpenAI presets need an explicit
  `--base-url` (e.g. a local server such as the `local` default
  `http://127.0.0.1:8080/v1`); `custom` always needs one. The UI also offers
  model discovery (`GET {base}/models`) and a connection test, which are
  metadata reads only and never invoke the model.
- Never put real secrets in shell history files, transcripts, config files
  or issue reports. Prefer exporting them in the current shell only.

## CLI usage

```sh
lattice --help
lattice --version                      # prints 0.0.0
lattice                                # no args: open the UI here
lattice status [workspace] [--json] [--workspace <path>] [--data-dir <path>]

lattice run --task "<objective>" --model <id> [--provider openai]
  [--base-url <url>] [--accept "<criterion>" ...]
  [--verify <exe> [--verify-arg <a> ...]] [--max-iterations N]
lattice run --resume <taskId> [same run options]

lattice sessions [--json]
lattice resume <taskId> [--json]           # inspect only; never starts the model
lattice export --session <id> --out <path> # local JSONL snapshot; sends nothing
lattice wake <taskId> --source <s> --cursor <c> --observation <text> [--wait <id>] [--level]
lattice ui [--workspace <path>] [--port <n>] [--no-open]
```

Global flags: `--workspace <path>` (or a positional workspace argument;
never both), `--data-dir <path>` (override the data directory), `--json`
(machine-readable output where supported).

## Desktop/Web UI

```sh
lattice
lattice ui --workspace /path/to/project --port 4311 --no-open
```

The server binds loopback only and prints its address, e.g.
`lattice ui: http://127.0.0.1:4311`. Opening a browser is best-effort
convenience; with `--no-open` (or when no browser exists) use the printed
address manually. API calls require the session cookie issued on first page
load, and state-changing calls require a loopback origin.

## How Lattice works

- **TaskContract**: objective, scope, acceptance criteria, grants, realm and
  allowed provider/model, with revisions for every material change.
- **Durable state**: one SQLite database per data directory (automatic
  versioned migrations, currently schema 3); events, contracts, runs,
  intents, attempts, receipts, waits and usage live there, not in memory.
- **Tools**: `search`, `read`, `edit` (literal, version-checked, atomic
  replace), `exec` and `process` handles, all scoped to the workspace.
- **Verification**: your verification command runs against the workspace;
  results are recorded in a ledger and gate the STOP decision.
- **Accounting**: every physical model attempt is recorded with observed,
  estimated or unknown token quantities; unknown is never reported as zero.
- **Recovery**: single-owner generation per data directory, resume gate,
  crash classification (admitted-without-claim vs claimed-without-receipt),
  and manual resume under the same session and budget.

The implementation is designed around durable sessions, explicit task
states, authority checks, budget accounting, verification, and resumable
execution. The public source and tests are the canonical reference for the
behavior shipped in this repository.

## Agent Index / hackathon integration (optional)

Normal Lattice operation never depends on this. Without configuration,
`lattice index status` reports `unavailable` and everything else works.

```sh
lattice index status [--json]
lattice index setup --agent-id <id> [--days N] [--agentsview <path>]
  [--client <path>] [--python <path>] [--credential-file <path>] [--enable]
lattice index disable
lattice index report [--dry-run]
```

- External prerequisites (all yours to obtain): Python 3, an `agentsview`
  binary with Lattice provider support, the official pinned
  `agent-index-client` script with the Lattice agent filter, and a Plow
  credential obtained through the official `plow-agents` mint flow.
- Consent: `setup` writes local configuration only after validating the
  above, and enables periodic reporting only with `--enable`. Registration
  and every report are explicit; `--dry-run` proves the chain without
  publishing. `disable` stops future reporting while preserving history,
  sessions and the official install identity.
- Reporting publishes per-day, per-model token counts only. No prompts,
  transcripts, paths, patches, costs or secrets ever leave the machine
  through this path. Never share `PLOW_AGENT_TOKEN`, report keys or your
  install identity.

## Privacy / local data / security

- Local by default: the database (`lattice.db`), product config
  (`lattice.product.json`, never holds secrets) and optional index state
  live in the data directory: `$LATTICE_DATA_DIR` when set, otherwise
  `~/.local/share/lattice` on Linux (`$XDG_DATA_HOME/lattice` when set) or
  `%LOCALAPPDATA%\Lattice` on Windows.
- What leaves the machine: only the model requests you authorize by running
  a task (prompt, tool schemas and tool results sent to the configured
  provider endpoint), plus optional Agent Index reports described above.
- Keys stay out of transcripts, URLs, logs, exports and model context; the
  export writer refuses snapshots containing secret-shaped data.
- See `SECURITY.md` for reporting vulnerabilities.

## Current limitations

- Prerelease `0.0.0`: the npm package is not published yet; registry install
  is unverified until publication.
- One process owns a data directory at a time; concurrent CLIs on the same
  directory serialize, and a second live owner is refused rather than merged.
- Tested on Linux and Windows (CI runs both on Node 22.13.0 and 24.x);
  macOS support is not claimed.
- The `local-trusted` realm runs project commands with your user
  privileges: it offers scoping and cancellation, not sandbox isolation.
- A waiting task needs the app alive; a shut-down app does not wake.
  Tool calling on `local`/`custom` endpoints depends on the served model.
- No power-loss durability claims beyond crash-tested process kills with
  filesystem and SQLite intact.

## Development / tests

```sh
npm ci
npm run build        # compile + bundle the UI into dist/
npm run typecheck
npm run lint
npm test             # full Vitest suite (unit + integration)
npm run test:unit
npm run test:integration
npm run pack:test    # pack, inspect tarball, isolated global install, CLI/UI/agent/upgrade smokes
```

## License

MIT — see `LICENSE`.
