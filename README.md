# Lattice

Local-first agent harness runtime with a web UI. Point it at a project
folder, configure a provider, describe a task, and follow the work with
verifiable evidence: tool calls, diffs, test results and explicit task
states.

Requires Node.js >= 22.13.0. No native build step, no postinstall compile.

```sh
npm install
npm run build
```

Open the UI for the current directory (no flags required):

```sh
node ./dist/cli/main.js
```

Other entry points:

```sh
node ./dist/cli/main.js ui --workspace /path/to/project
node ./dist/cli/main.js run --task "Fix the bug" --provider openai --model <id>
node ./dist/cli/main.js status
```

Providers speak the OpenAI Chat Completions protocol: OpenAI, OpenRouter,
Google AI Studio, Abacus RouteLLM, a local OpenAI-compatible server, or a
custom endpoint. Model discovery, connection testing and credentials are
managed from Settings; keys stay in server memory and are never displayed
again.

Checks:

```sh
npm run typecheck
npm run lint
npm test
npm run pack:test
```

License: MIT. See [LICENSE](LICENSE).
