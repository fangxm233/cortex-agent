# Cortex — Autonomous Project Owner

[中文文档](./docs/zh/) | [Docs](https://fangxm233.github.io/cortex-agent/)

Cortex is an autonomous agent system for long-running projects. You give
it a mission with a success criterion, and it plans the work, dispatches
a pipeline of agents to execute it, keeps a structured log of progress
in your repo, and reviews itself before each commit — across days or
weeks of unattended work.

Cortex is designed around four failure modes of long agent runs.
**Context rot** — durable project state lives as plain files in your
repo, not chat history that accumulates and decays. **Execution drift**
— every task carries a verifiable success criterion, checked at
completion. **Context window limits** — work is partitioned across
agent pipelines, each with bounded scope and fresh context.
**Single-perspective bias** — adversarial review is a built-in pipeline
stage, not a polite suggestion.

## Features

- **Mission-driven task system** — hand off a goal; Cortex decomposes
  it into tracked tasks with priorities, dependencies, and verifiable
  done-conditions, works through them autonomously, and stops to ask
  only when blocked. You stop maintaining the todo list.
  See [docs/tasks.md](./docs/tasks.md).

- **Multi-agent thread pipelines** — long jobs run as a relay of
  focused agents instead of one overloaded session. Each step starts
  with a clean context and a narrow scope, so the model never loses
  the plot mid-task. Handoffs carry only what the next stage needs.
  See [docs/threads.md](./docs/threads.md).

- **Structured project log** — every project keeps mission, roadmap,
  status, experiments, knowledge, patterns, and decisions as plain
  files in your repo. A fresh agent (or a fresh you, weeks later) can
  pick up where the last one left off — no chat history to scroll, no
  vector store to query.
  See [docs/memory.md](./docs/memory.md).

- **Cron and interval scheduling** — schedule Cortex to scan a domain
  every morning, ship a weekly digest, or sweep an inbox every few
  minutes. Schedules persist across restarts and hot-reload without
  downtime.
  See [docs/scheduling.md](./docs/scheduling.md).

- **Self-evolving skills** — when Cortex catches itself doing the same
  thing a third time, it drafts a new skill, you approve, and future
  runs use it automatically. The longer Cortex runs, the more your
  patterns become first-class behavior.
  See [docs/skills-and-plugins.md](./docs/skills-and-plugins.md).

- **One agent across your machines** — your compute, documents, code,
  and tools rarely live on one box. Connect any Mac, Windows, or Linux
  machine as a remote host via `cortex-client`, and Cortex can read,
  write, and execute across all of them from a single control plane.
  See [docs/cross-machine.md](./docs/cross-machine.md).

- **Backend agnostic** — runs on Claude Code or PI today, with adapter
  abstraction for additional coding agents. Use the LLM subscription
  you already pay for — no extra API key, no second bill.

- **Use Cortex from the Web, native apps, chat, or a terminal** — open
  the browser workbench, install the Linux/macOS/Windows desktop app or
  Android app, message Cortex through Slack or Feishu, or use the TUI.
  Every interface reaches the same projects, sessions, tasks, and memory.
  See [Browser Access](./docs/browser-access.md) and
  [Desktop and Android Apps](./docs/desktop-app.md).

## Quickstart

Requirements: Node 20+ and an installed coding agent backend (Claude Code or PI).

```bash
# Install
npm install -g @cortex-agent/server

# Initialize (guided setup)
cortex init

# Start
cortex daemon
```

Once running, use Slack or Feishu, open the browser workbench, or connect a
native app. Every interface reads the same project context and dispatches work
through the same server. Browser deployment is covered in
[Browser Access](./docs/browser-access.md); native installation is covered in
[Desktop and Android Apps](./docs/desktop-app.md).

For a detailed step-by-step guide covering setup wizard prompts, what files
are created, and how to send your first message, see
[docs/quickstart.md](./docs/quickstart.md).

## How a project looks

Each project lives under `.cortex/context/projects/<name>/` with a
predictable layout:

```
projects/my-project/
├── mission.md           # Goal and success criteria
├── roadmap.md           # Milestones and timeline
├── STATUS.md            # Current state (overwrite)
├── ISSUES.md            # Open friction points (append)
├── TASKS.yaml           # Machine-readable task queue
├── decisions/           # DR-NNNN.md design decisions (append)
├── experiments/         # EXP-NNN.md atomic experiment records
├── knowledge/           # K-NNN.md atomic knowledge entries
├── patterns/            # PAT-NNN.md cross-experiment patterns
└── tasks-archive.md     # Completed tasks (auto-archived)
```

This is the project log. It survives sessions, restarts, and model
upgrades. A fresh agent can resume work from here without the previous
conversation.

## Safety boundaries

Cortex classifies operations by blast radius. The harness enforces this
at the tool-call layer.

| Class             | Examples                                                   |
|-------------------|------------------------------------------------------------|
| Autonomous        | read files, run small scripts, edit context files, web search, in-budget compute |
| Requires approval | modify CLAUDE.md rules, add new skills, change agent-server behavior, over-budget compute, delete data |
| Forbidden         | system-level package install, system config changes, `rm -rf` |

The approval queue lives at `.cortex/context/PENDING_APPROVALS.md`.
Configure additional rules in `.claude/settings.json`.

## Configuration

All configuration lives under `$CORTEX_HOME/config/`. Only
`CORTEX_PLATFORM` and your platform credentials (Slack tokens) are
required. Run `cortex init` for guided setup. The full environment
variable reference, file layout, and precedence rules are in
[docs/configuration.md](./docs/configuration.md).

## Docs

| Doc | What it covers |
|---|---|
| [Quickstart](./docs/quickstart.md) | Install, init, and first Slack message in 5 minutes |
| [Desktop & Android Apps](./docs/desktop-app.md) | Native installation, connection, downloads, and updates |
| [Browser Access](./docs/browser-access.md) | Web workbench authentication and deployment |
| [Slack Setup](./docs/slack-setup.md) | App creation, token collection, Socket Mode, scopes |
| [Configuration](./docs/configuration.md) | Full `.env` reference, `profiles.json`, file layout, hot-reload |
| [CLI Reference](./docs/cli-reference.md) | `cortex`, `cortex-task`, `cortex-run` — every subcommand and flag |
| [Backends](./docs/backends.md) | Claude Code vs PI, feature matrix, fallback, cost reporting |
| [Architecture](./docs/architecture.md) | Server layers, WS protocol, event bus |
| [Threads](./docs/threads.md) | Multi-agent pipelines, templates, transitions, hooks |
| [Tasks](./docs/tasks.md) | TASKS.yaml format, lifecycle, dispatch, cortex-run watchdog |
| [Memory](./docs/memory.md) | EXP/K/PAT atomized knowledge, project log governance |
| [Skills & Plugins](./docs/skills-and-plugins.md) | Skill authoring, plugin layout, third-party plugins |
| [Scheduling](./docs/scheduling.md) | Interval/daily/weekly/once schedules, preCheck, fallback |
| [Safety & Approvals](./docs/safety-and-approvals.md) | Blast-radius classes, approval workflow, audit trail |
| [Hooks](./docs/hooks.md) | Hook lifecycle, hook-bridge, custom hooks in settings.json |
| [MCP](./docs/mcp.md) | Privilege-scoped Cortex MCP servers, third-party MCP |
| [Cross-machine](./docs/cross-machine.md) | cortex-client deployment, remote tools, network topology |

## Developing on Cortex

```bash
# Clone and install dependencies
git clone https://github.com/<your-org>/cortex
cd cortex/agent-server && npm install

# Build
npm run build

# Run tests
npm test

# Start in dev mode (hot-reload via .restart watcher)
npm run build && npm start
```

### Architecture

Cortex's core workspace and plugin packages are:

| Package | Directory | Role |
|---------|-----------|------|
| `@cortex-agent/server` | `agent-server/` | Control plane, chat adapters, task dispatch, scheduling, and thread orchestration |
| `@cortex-agent/client` | `client/` | Remote worker that executes tools over the client WebSocket |
| `@cortex-agent/web` | `web/` | Browser, desktop, and mobile workbench SPA |
| `@cortex-agent/desktop` | `desktop/` | Tauri shell for Linux, macOS, Windows, and Android |
| `@cortex-agent/ui-contract` | `packages/ui-contract/` | Shared typed contract between the server and workbench |
| `@cortex-agent/deepseek-relay-worker` | `packages/deepseek-relay-worker/` | Authenticated Cloudflare Worker for DeepSeek API egress |
| Plugins | `plugins/` | Role-scoped skills loaded by thread agents at runtime |

The server is organized in six layers (`src/`): core utilities → persistence
→ event bus → domain logic → orchestration → entry points. Test coverage is
mandatory for all code changes. See [docs/architecture.md](./docs/architecture.md)
for the full architecture.

## License

MIT
