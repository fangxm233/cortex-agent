# Cortex — Project Codebase

Cortex is an autonomous research agent system for robotics and AI/ML. It runs as a Node.js server-client architecture: the agent-server orchestrates work — agent sessions, scheduling, Slack/Feishu integration — while remote agent instances connect as clients via WebSocket to execute commands on remote machines.

## Top-Level Structure

| Directory | Purpose |
|-----------|---------|
| `agent-server/` | Main server application (TypeScript, Node.js >=22.19.0). Slack/Feishu bot, LLM orchestration, scheduling, MCP tools. |
| `client/` | Remote agent client (TypeScript, Node.js >=20). Connects to agent-server via WebSocket and executes bash/read/write/edit/glob/grep commands locally. |
| `web/` | Vite + React SPA; browser-responsive desktop/mobile layouts share one router. Built to `web/dist`, served by the in-core UI host and native shells. Layer map + enforced import rules: `web/.dependency-cruiser.cjs`. |
| `desktop/` | Tauri v2 desktop/Android shell. Serves the SPA through the `cortexui://` custom scheme — the bundled `web/dist`, or a newer frontend bundle downloaded from the server (OTA). Exposes the `get_connection_config` Tauri command plus `window.__CORTEX_DESKTOP_CONFIG` for injecting `{serverUrl, token}` into the SPA. |
| `packages/` | Shared/deployment packages: `ui-contract` provides Web UI tRPC types; `deepseek-relay-worker` is the authenticated, fixed-upstream Cloudflare Worker used when the agent-server host cannot reach DeepSeek directly. |
| `benchmark/` | Installable adapters and reproducibility tooling for external benchmark harnesses. |
| `scripts/` | Repository maintenance scripts for scheduled source-checkout jobs. |
| `context/` | Structured knowledge repository for research projects (experiments, knowledge entries, patterns). |
| `tmp/` | Experiment artifacts, analysis scripts, logs, and working files. |
| `.claude/` | Claude Code configuration (settings.json, hooks, plans). |

## Agent Server Architecture

The server follows a six-layer structure (`agent-server/src/`):

| Layer | Directory | Purpose |
|-------|-----------|---------|
| L0 | `core/` | Shared kernel: types, path constants, settings, async-mutex, run/session state, CLI utils. No runtime imports of other layers; type-only imports are allowed |
| L1 | `store/` | Persistence: 13 JSON-based repositories with atomic writes |
| L2 | `events/` | Event bus: typed EventBus, daily-rolling JSONL logger |
| L3 | `domain/` | Business logic: agents, sessions, runs, executions, costs, scheduling, waitpoints, memory, remote clients, MCP |
| L4 | `orchestration/` | Message routing, the `Turn` (one owner per conversation turn) + background holds, the `session-gateway` entry, 15 !commands, interactions |
| L5 | `entry/` | Entry points: app.ts (composition root), daemon.ts (process supervisor), CLI |

The server supports two LLM backends via `agent-adapter/`: Claude Code and PI. Platform adapters in `platform/` support Slack and Feishu/Lark.

## Client Architecture

The client (`client/src/`) is a lightweight WebSocket daemon that:
- Connects to agent-server and executes commands locally
- Does not launch or supervise long-running jobs: those run independently and report back through a waitpoint (`docs/waitpoints.md`)
- Handles automatic reconnection on transient disconnects

## Key Configuration

| File | Purpose |
|------|---------|
| `agent-server/package.json` | npm package, dependencies, scripts, binaries (cortex, cortex-evidence-export, cortex-hook, cortex-signal) |
| `agent-server/tsconfig.json` | TypeScript config (ES2022, NodeNext) |
| `agent-server/defaults/` | Shipped default config, context templates, plugins, hooks, prompts, rules |
| `agent-server/tests/` | Vitest regression suite (~510 test files) covering all major subsystems |

## Runtime Data (gitignored, at `~/.cortex/`)

| Path | Purpose |
|------|---------|
| `data/agent-state.json` | Agent selection state (active profile, default agent) |
| `config/profiles.json` | Named agent profile list |
| `config/budget.json` | Daily/monthly budget limits |
| `data/costs.jsonl` | Per-call cost records (90-day rolling) |
| `data/schedules.json` | Scheduled tasks |
| `data/provider-state.json` | Provider usage, throttle windows and provider-attributed resume queue |
| `data/session-registry.jsonl` | Session registry: sessions, channel bindings, turns |
| `data/executions.json` | Unified execution registry |
| `config/environments/` | Execution environments: one JSON file per environment (`main`, `creative`, and any the user adds) |
| `config/archive/`, `data/archive/` | Configuration and state an upgrade retired, moved aside rather than deleted |
| `logs/` | Daemon and LLM logs |

### CLI Design

When adding new CLI commands, flags, or tools, consult `/cli-standards` for the 7 mandatory design rules.
