# Cortex — Project Codebase

Cortex is an autonomous research agent system for robotics and AI/ML. It runs as a Node.js server-client architecture: the agent-server orchestrates work — task dispatch, thread execution, scheduling, Slack/Feishu integration — while remote agent instances connect as clients via WebSocket to execute commands on remote machines.

## Top-Level Structure

| Directory | Purpose |
|-----------|---------|
| `agent-server/` | Main server application (TypeScript, Node.js >=20). Slack/Feishu bot, LLM orchestration, scheduling, task system, MCP tools. See [agent-server/CORTEX.md](agent-server/CORTEX.md). |
| `client/` | Remote agent client (TypeScript, Node.js >=20). Connects to agent-server via WebSocket, executes bash/read/write/edit/glob/grep commands locally, supports cortex-run for long-running task execution. See [client/src/CORTEX.md](client/src/CORTEX.md). |
| `web/` | Web SPA (Vite + React 18, tRPC client), including active-only provider throttle status on desktop and mobile Projects. Built to `web/dist`, served by the in-core UI host and desktop shell. |
| `desktop/` | Tauri v2 desktop shell. Loads `web/dist` via asset protocol in a native webview. Exposes `get_connection_config` / `set_connection_config` Tauri commands plus `window.__CORTEX_DESKTOP_CONFIG` for injecting `{serverUrl, token}` into the SPA. See [desktop/CORTEX.md](desktop/CORTEX.md). |
| `packages/` | Shared/deployment packages: `ui-contract` provides Web UI tRPC types; `deepseek-relay-worker` is the authenticated, fixed-upstream Cloudflare Worker used when lab2 cannot reach DeepSeek directly. |
| `context/` | Structured knowledge repository for research projects (experiments, knowledge entries, patterns). |
| `tmp/` | Experiment artifacts, analysis scripts, logs, and working files. |
| `.claude/` | Claude Code configuration (settings.json, hooks, plans). |

## Agent Server Architecture

The server follows a six-layer structure (`agent-server/src/`):

| Layer | Directory | Purpose |
|-------|-----------|---------|
| L0 | `core/` | Zero-dependency utilities: types, path constants, async-mutex, CLI utils, task parser |
| L1 | `store/` | Persistence: 12 JSON-based repositories with atomic writes |
| L2 | `events/` | Event bus: typed EventBus, daily-rolling JSONL logger, replay CLI |
| L3 | `domain/` | Business logic: agents, sessions, tasks, executions, costs, scheduling, memory, remote clients, threads, MCP |
| L4 | `orchestration/` | Message routing, agent runner, thread executor, lifecycle, 14 !command handlers, interactions |
| L5 | `entry/` | Entry points: app.ts (composition root), daemon.ts (process supervisor), CLI |

The server supports three LLM backends via `agent-adapter/`: Claude Code, Codex, and PI. Platform adapters in `platform/` support Slack and Feishu/Lark.

## Client Architecture

The client (`client/src/`) is a lightweight WebSocket daemon that:
- Connects to agent-server and executes commands locally
- Supports `cortex-run.launch` / `cortex-run.cancel` for long-running task management with stall detection and callback reporting
- Handles automatic reconnection on transient disconnects

## Key Configuration

| File | Purpose |
|------|---------|
| `agent-server/package.json` | npm package, dependencies, scripts, binaries (cortex, cortex-run, cortex-task) |
| `agent-server/tsconfig.json` | TypeScript config (ES2022, NodeNext) |
| `agent-server/defaults/` | Shipped default config, context templates, plugins, hooks, prompts, rules |
| `agent-server/tests/` | 45+ test files covering all major subsystems |

## Runtime Data (gitignored, at `~/.cortex/`)

| Path | Purpose |
|------|---------|
| `mode.json` | Current runtime mode and profile |
| `profiles.json` | Named agent profile list |
| `budget.json` | Daily/monthly budget limits |
| `costs.jsonl` | Per-call cost records (90-day rolling) |
| `schedules.json` | Scheduled tasks, provider/window throttle records, and pending global resume queue |
| `sessions.json` | Channel-to-agent session mapping |
| `executions.json` | Unified execution registry |
| `thread-templates.json` | Agent definitions and orchestration templates |
| `threads.json` | Active and historical thread state |
| `tasks/` | Project task queues (TASKS.yaml per project) |
| `logs/` | Daemon and LLM logs |

## Development Guidelines

### TDD is Mandatory

**No production code without a failing test first.** This is the iron law for all code changes in this repo — features, bugfixes, and refactors alike. If you wrote code before a test, delete the code, write the test, watch it fail, then reimplement.

Use the `/develop` skill for all code changes. It enforces the TDD workflow:

1. **Understand** — read relevant source, check `context/decisions/`, search for existing patterns to reuse.
2. **Write tests** — happy path, edge cases, integration points. Run them, confirm they fail.
3. **Implement** — minimum code to make tests pass. Follow existing naming, error handling, and type patterns.
4. **Verify** — all tests pass (`npm test`). Review diff with `git diff`.
5. **Document** — update relevant STATUS.md, add Decision Record if warranted.

### Bugfixes

Bugfixes follow the same TDD discipline with an extra step: write a **regression test** that reproduces the bug before applying the fix. The test must fail on current code and pass after the fix.

### Test Locations

Tests live colocated near source or in `tests/` directories:
- `agent-server/tests/` — server tests (vitest; `vitest.config.ts` + `vitest.integration.config.ts`)
- `client/` — client tests (Node built-in runner with `tsx`)

Run server tests: `cd agent-server && npm test`

### When TDD Does Not Apply

TDD is mandatory for code changes. It does NOT apply to:
- Pure documentation changes (CORTEX.md, STATUS.md, experiment files)
- Configuration value changes with no code path
- Prompt text changes in skills (SKILL.md files)
- One-time data analysis scripts

When in doubt: if the change could introduce a regression, it needs a test.

### Red Flags

Stop and return to writing tests if you find yourself:
- Writing implementation code before any test exists
- A test passing immediately without implementation changes
- Rationalizing "just this once"
- Three or more fix attempts on the same bug — this signals an architectural problem, not a simple bug

### CLI Design

When adding new CLI commands, flags, or tools, consult `/cli-standards` for the 7 mandatory design rules.
