<div align="center">

# Cortex

**An autonomous agent workbench for long-running projects.**

Give it a mission. It plans the work, runs it across your machines with a team of agents,<br>
keeps the project's memory in plain files, and asks you only when it matters.

[![Release](https://img.shields.io/github/v/release/fangxm233/cortex-agent?filter=server-v*&label=release)](https://github.com/fangxm233/cortex-agent/releases)
[![npm](https://img.shields.io/npm/v/@cortex-agent/server?label=npm)](https://www.npmjs.com/package/@cortex-agent/server)
[![Docs](https://img.shields.io/badge/docs-fangxm233.github.io-4f46e5)](https://fangxm233.github.io/cortex-agent/)
[![License](https://img.shields.io/github/license/fangxm233/cortex-agent)](https://github.com/fangxm233/cortex-agent/blob/main/LICENSE)

[Download](#download) · [Docs](https://fangxm233.github.io/cortex-agent/) · [中文](https://github.com/fangxm233/cortex-agent/blob/main/docs/zh/README.md)

</div>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/hero-dark.png">
  <img alt="The Cortex workbench: projects, sessions and workers on the left, a lead session reporting results in the middle, and its live board on the right" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/hero-light.png">
</picture>

## Download

| Platform | Installer |
|---|---|
| macOS · Apple Silicon | [Cortex-2026.10.15-macOS-aarch64.dmg](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15/Cortex-2026.10.15-macOS-aarch64.dmg) |
| macOS · Intel | [Cortex-2026.10.15-macOS-x86_64.dmg](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15/Cortex-2026.10.15-macOS-x86_64.dmg) |
| Windows · x64 | [Cortex-2026.10.15-Windows-x86_64-setup.exe](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15/Cortex-2026.10.15-Windows-x86_64-setup.exe) |
| Linux · x86_64 | [AppImage](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15/Cortex-2026.10.15-Linux-x86_64.AppImage) · [deb](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15/Cortex-2026.10.15-Linux-amd64.deb) · [rpm](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15/Cortex-2026.10.15-Linux-x86_64.rpm) |
| Android · arm64 | [Cortex-2026.10.15-Android-arm64.apk](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.15/Cortex-2026.10.15-Android-arm64.apk) |

The desktop app installs and starts a Cortex server on the same computer in one click, with no
terminal and no Node.js to set up, or connects to a server you already run. The Android app connects
to a server. For a headless machine, install the server with npm (see [Get started](#get-started)).
Other versions are on the [Releases page](https://github.com/fangxm233/cortex-agent/releases).

## What Cortex is

Cortex runs coding agents (Claude Code, or PI with the provider you already pay for) as a
long-lived service with a real workbench in front of them. It is built for work that takes days
rather than minutes: research studies, multi-step engineering, and recurring scans and digests. It
targets the three ways long agent runs go wrong:

- **Context rot.** A project's mission, status, experiments, and decisions live as plain files on
  disk, not in a chat history that grows until it decays.
- **Execution drift.** Non-trivial work starts from a plan you approve. Long tasks keep a live
  board of where they stand, and claims of completion point at their evidence.
- **Context limits.** Bounded pieces of work go to subagents and workers that start with a fresh
  context and return only their result.

## A tour of the workbench

### Plans, tools, and questions in one conversation

<img alt="A session paused on its plan, with Request changes and Approve plan buttons" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/plan-approval.png">

Every session streams its reasoning, tool calls, subagent runs, and files into one transcript.
Before non-trivial work the agent writes a plan and waits. You read it, then approve it or send
it back with the changes you want, from the card in the chat. Questions and decisions arrive the same way, as cards you
answer in place, on desktop or on your phone.

### Boards for long work

<p align="center"><img width="640" alt="A board showing the study's live strip, stage cards, results table and plot" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/board.png"></p>

When a task spans many hours or several workers, the agent opens a **board**: a status page
docked beside the conversation. The board shows where the work stands, what comes next, what is
waiting on you, and every decision taken so far. You can approve, ask about, or revise a decision
from the board itself. The lead and its workers keep the board current, and it refreshes seconds
after each edit. [Boards →](https://fangxm233.github.io/cortex-agent/team/#boards)

### A team of workers

<img alt="A lead session with its worker roster open, showing each worker's state and its latest report" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/team.png">

You talk to one session, the **lead**. When the work splits, the lead hands pieces to persistent
**worker** sessions, follows up with them, answers their questions, and reports back. The capsule in
the chat header shows how many workers are running and opens a list of what each one is doing. Bounded jobs such as a search,
a review, or a verification run go to one-shot subagents instead.
[Team mode →](https://fangxm233.github.io/cortex-agent/team/)

### Project memory you can read

<img alt="The memory view of a project: mission, status, experiment records and knowledge entries" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/memory.png">

Each project keeps its mission, roadmap, status, experiment records, knowledge entries, patterns, and
decision records as Markdown under `context/projects/<name>/`. A new session, or you weeks later,
picks up from those files rather than from a transcript. The **Memory** view browses them and, when
the project is in a git work tree, shows the latest change behind each line. [Memory →](https://fangxm233.github.io/cortex-agent/memory/)

### Spend, schedules, and runs per project

<img alt="A project's overview: today's spend against its daily budget, a 14-day chart, its schedules, and recent executions" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/usage.png">

Each project's overview shows today's spend against its daily budget, the week's and month's totals,
its schedules, and its recent executions with their duration, cost, and logs. Interval, daily, weekly, and
one-off schedules start ordinary sessions on their own: a morning scan of new papers, a weekly
digest, a check every few minutes. Schedules survive restarts and hot-reload without downtime.
[Scheduling →](https://fangxm233.github.io/cortex-agent/scheduling/)

### All your machines

<p align="center"><img width="560" alt="The machines menu with live CPU, memory, disk and per-GPU telemetry" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/machines.png"></p>

Your GPUs, documents, and tools rarely live on one box. Run `cortex-client` on any Linux, macOS, or
Windows machine and the agent can read, write, and execute there from the same session. The
**Machines** menu shows each machine's live CPU, memory, disk, and GPU load. In the desktop app, the
dock opens a development server running on a remote machine as if it ran locally.
[Cross-machine →](https://fangxm233.github.io/cortex-agent/cross-machine/)

### On your phone

<img alt="The Android app: the session list, a lead session with decisions and workers, and a plan waiting for approval" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/mobile-strip.png">

The Android app has the same sessions, boards, approvals, and memory in a phone layout. It can
notify you in the background when a turn finishes or when a session is waiting for your answer.
[Desktop and Android apps →](https://fangxm233.github.io/cortex-agent/desktop-app/)

### Bring your own models

<p align="center"><img width="640" alt="Model providers: a connected OpenAI Codex login and the catalog of providers to add with an API key or OAuth" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/provider-setup.png"></p>

Cortex drives a coding agent instead of calling a model API itself. PI ships inside the server and
signs in to dozens of providers, including subscriptions such as ChatGPT Plus/Pro, with OAuth or an
API key. Claude Code is optional and uses your own Claude login. Usage and cost are tracked per
session and per provider. [Backends →](https://fangxm233.github.io/cortex-agent/backends/)

## Get started

### Desktop app

[Download](#download) the app for your platform, open it, and choose **Install Cortex**. The app
unpacks its own Node.js runtime, installs the server into a private prefix under `~/.cortex`, starts
it, and opens provider setup. Sign in to a provider, pick a default profile, and enter the
workbench. Choose **Connect an existing server** instead to use a server running elsewhere.
[Desktop and Android apps →](https://fangxm233.github.io/cortex-agent/desktop-app/)

### Server from a terminal

Requires Node.js 22.19 or later.

```bash
npm install -g @cortex-agent/server
cortex init        # guided setup: chat platforms, machine name, provider login
cortex ui enable   # turn on the Web workbench and app endpoint
cortex daemon      # start the server in the background
```

Open `http://127.0.0.1:3004` on the server, or connect the desktop or Android app with the
server's address and client token. [Quickstart →](https://fangxm233.github.io/cortex-agent/quickstart/)

### Other ways in

Every interface reaches the same projects, sessions, schedules, and memory:

| Interface | Guide |
|---|---|
| Browser workbench, served by the server and protected by Cloudflare Access | [Browser access](https://fangxm233.github.io/cortex-agent/browser-access/) |
| Slack or Feishu, for chat-driven work and notifications | [Slack setup](https://fangxm233.github.io/cortex-agent/slack-setup/) · [Quickstart](https://fangxm233.github.io/cortex-agent/quickstart/) |
| `cortex tui`, a full-screen terminal interface | [CLI reference](https://fangxm233.github.io/cortex-agent/cli-reference/) |

## How a project is stored

```
context/projects/optimizer-study/
├── mission.md        # goal and success criteria
├── roadmap.md        # milestones
├── STATUS.md         # current state (overwritten)
├── ISSUES.md         # open friction points (appended)
├── boards/           # status pages of long tasks
├── decisions/        # design decision records
├── experiments/      # EXP-NNN.md, one per experiment
├── knowledge/        # K-NNN.md, one per confirmed finding
└── patterns/         # PAT-NNN.md, patterns across experiments
```

These are ordinary Markdown files, kept in a git repository when Git is installed. They survive
sessions, restarts, and model upgrades, and any agent or person can read them.

## Safety and approvals

Cortex gives agents real tools: shell, files, GPUs, and other machines. Its guard rails are
conversational rather than a sandbox:

- **Plan approval.** Non-trivial work starts with a plan that waits until you approve it or send
  it back for changes.
- **Questions and decisions.** Agents ask through cards that you answer in place, and record the
  choices they make on their own as decision cards you can review.
- **Your rules.** A safety boundary in your `$CORTEX_HOME/AGENTS.md` tells every session what it may
  do alone, what needs sign-off, and what is forbidden. Operations that need sign-off wait in the
  **Approval Center**.

[Safety and approvals →](https://fangxm233.github.io/cortex-agent/safety-and-approvals/)

## Documentation

| Guide | What it covers |
|---|---|
| [Quickstart](https://fangxm233.github.io/cortex-agent/quickstart/) | Install, `cortex init`, the Web workbench, and your first messages |
| [Desktop & Android apps](https://fangxm233.github.io/cortex-agent/desktop-app/) | Native installation, local server setup, provider setup, the workbench, notifications, updates |
| [Browser access](https://fangxm233.github.io/cortex-agent/browser-access/) | Serving the Web workbench and protecting it with Cloudflare Access |
| [Slack setup](https://fangxm233.github.io/cortex-agent/slack-setup/) | App creation, tokens, Socket Mode, scopes |
| [Team mode](https://fangxm233.github.io/cortex-agent/team/) | Leads, workers, reports, and boards |
| [Memory](https://fangxm233.github.io/cortex-agent/memory/) | The project log: experiments, knowledge, patterns, decisions |
| [Scheduling](https://fangxm233.github.io/cortex-agent/scheduling/) | Interval, daily, weekly, and one-off schedules |
| [Backends](https://fangxm233.github.io/cortex-agent/backends/) | Claude Code and PI, providers, fallback, cost reporting, subagents |
| [Configuration](https://fangxm233.github.io/cortex-agent/configuration/) | `config/.env`, `settings.json`, profiles, execution environments |
| [CLI reference](https://fangxm233.github.io/cortex-agent/cli-reference/) | `cortex`, `cortex-signal`, and `cortex-hook` |
| [Skills & plugins](https://fangxm233.github.io/cortex-agent/skills-and-plugins/) | Writing, overriding, and packaging skills |
| [Safety & approvals](https://fangxm233.github.io/cortex-agent/safety-and-approvals/) | The safety boundary, approval queue, and interactive cards |
| [Hooks](https://fangxm233.github.io/cortex-agent/hooks/) | Hook lifecycle, built-in hooks, and custom hooks |
| [Waitpoints](https://fangxm233.github.io/cortex-agent/waitpoints/) | Waiting on external jobs without polling |
| [MCP](https://fangxm233.github.io/cortex-agent/mcp/) | Cortex's MCP tools and third-party servers |
| [Cross-machine](https://fangxm233.github.io/cortex-agent/cross-machine/) | Deploying `cortex-client` and using remote tools |
| [Architecture](https://fangxm233.github.io/cortex-agent/architecture/) | Server layers, protocols, and the event bus |

## Developing Cortex

```bash
git clone https://github.com/fangxm233/cortex-agent.git
cd cortex-agent
pnpm install
pnpm --filter @cortex-agent/ui-contract --filter @cortex-agent/server --filter @cortex-agent/web build
pnpm --filter @cortex-agent/server test
```

| Package | Directory | Role |
|---|---|---|
| `@cortex-agent/server` | `agent-server/` | Control plane: sessions, orchestration, scheduling, chat adapters, the Web UI host |
| `@cortex-agent/client` | `client/` | Remote worker that runs tools on another machine over WebSocket |
| `@cortex-agent/web` | `web/` | The workbench SPA for browser, desktop, and mobile |
| `@cortex-agent/desktop` | `desktop/` | Tauri shell for Linux, macOS, Windows, and Android |
| `@cortex-agent/ui-contract` | `packages/ui-contract/` | Typed contract between the server and the workbench |
| `@cortex-agent/deepseek-relay-worker` | `packages/deepseek-relay-worker/` | Cloudflare Worker relay for DeepSeek API egress |

`pnpm --dir web dev` serves the workbench with hot reload against a server on port 3004 (set
`CORTEX_CLIENT_TOKEN` in that shell), and `pnpm --dir desktop dev` runs the native shell, which needs
a Rust toolchain. The server is organized in six layers, from core utilities to entry points, described in
[Architecture](https://fangxm233.github.io/cortex-agent/architecture/). Code changes come with tests.

## License

[MIT](https://github.com/fangxm233/cortex-agent/blob/main/LICENSE)
