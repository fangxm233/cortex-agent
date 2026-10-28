<div align="center">

# Cortex

**An agent workbench for auto research, self-improvement loops, and other work that runs for days.**

Give it a mission. It plans the work, runs it across your machines and GPUs with a team of agents,<br>
keeps every result in plain files that outlast any session, and asks you only when it matters.

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
| macOS · Apple Silicon | [Cortex-2026.10.28-macOS-aarch64.dmg](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.28/Cortex-2026.10.28-macOS-aarch64.dmg) |
| macOS · Intel | [Cortex-2026.10.28-macOS-x86_64.dmg](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.28/Cortex-2026.10.28-macOS-x86_64.dmg) |
| Windows · x64 | [Cortex-2026.10.28-Windows-x86_64-setup.exe](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.28/Cortex-2026.10.28-Windows-x86_64-setup.exe) |
| Linux · x86_64 | [AppImage](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.28/Cortex-2026.10.28-Linux-x86_64.AppImage) · [deb](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.28/Cortex-2026.10.28-Linux-amd64.deb) · [rpm](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.28/Cortex-2026.10.28-Linux-x86_64.rpm) |
| Android · arm64 | [Cortex-2026.10.28-Android-arm64.apk](https://github.com/fangxm233/cortex-agent/releases/download/server-v2026.10.28/Cortex-2026.10.28-Android-arm64.apk) |

The desktop app installs and starts a Cortex server on the same computer in one click, with no
terminal and no Node.js to set up, or connects to a server you already run. The Android app connects
to a server. For a headless machine, install the server with npm (see [Get started](#get-started)).
Other versions are on the [Releases page](https://github.com/fangxm233/cortex-agent/releases).

## What Cortex is

A coding agent in a terminal is built around one session: one task, one machine, done within the
hour. Auto research and recursive self-improvement (RSI) need more. A study runs for days and
outlives every session in it. Its results have to be kept and compared run after run. The work
splits among several agents, and the experiments run on GPU servers rather than on the machine the
agent started from.

Cortex is the environment for that kind of work. It runs coding agents (Claude Code, or PI with the
provider you already pay for) as a long-lived service with a workbench in front of them:

- **Work continues across sessions.** A project's mission, status, and decisions live as plain
  files on disk rather than in a chat history that grows until it decays, so a new session picks up
  where the last one stopped. Schedules start recurring work, and waitpoints wake a session when a
  job it launched finishes.
- **Results are kept.** Each experiment gets its own record of what ran, what came out, and what it
  means. Confirmed findings and patterns across experiments collect beside them.
- **Agents work as a team.** A lead session hands pieces to persistent workers and one-shot
  subagents, each starting with a fresh context, and keeps a live board of where the work stands.
- **Agents manage model training across your machines.** One session reads, writes, and runs
  commands on any machine running `cortex-client`. Agents check which GPUs are free, launch training
  and evaluation runs there, and wait on them without polling, while the workbench shows each GPU's
  live load.
- **The setup itself can improve.** Skills, rules, hooks, and Cortex's own source are files the
  agents can change, inside a safety boundary you write. Cortex itself is developed entirely inside
  Cortex.

## How Cortex compares

Cortex does not replace Claude Code, Codex, or PI. It runs them as a long-lived service: work that
lasts for days, GPU servers across machines, and fewer tokens spent along the way. Claude Code and PI
are its backends and run on the subscriptions you already have, including a ChatGPT plan through PI.

| | Terminal coding agents<br>(Claude Code, Codex CLI, PI) | Chat assistants | Cortex |
|---|---|---|---|
| **Shape of work** | One session on one machine, sized for hour-scale tasks | One conversation; results stay in the chat | A long-lived service; one piece of work spans sessions and days |
| **GPUs and servers** | You SSH in, find a free GPU, and check on the run yourself | Usually no access to your machines | Connected servers report live GPU load; agents pick free GPUs, launch runs, and wake when they finish |
| **Tokens on long tasks** | Context piles up and is compacted again and again | A long task lives in one growing conversation | Subtasks start from a clean context, state lives on disk, and waits don't poll: about 20% fewer tokens on similar tasks |
| **Models** | Claude Code and Codex center on their vendor's models; PI is multi-provider | Set by the platform | Claude Code, or PI with dozens of providers, including DeepSeek, Qwen, Kimi, and GLM |
| **Multiple agents** | Mostly one agent; some add subagents | Mostly one agent | A lead runs up to 8 workers at once, plus one-shot subagents, with a live board |
| **What is kept** | The session transcript and a notes file such as `CLAUDE.md` or `AGENTS.md` | The chat history | Experiments, findings, and decisions as plain files in the project |
| **Where you use it** | Terminal or IDE | Web or app | Web, desktop, Android, Slack, Feishu, and terminal, all on one server |

The comparison reflects each product's public positioning; check their own docs for current details.

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

### Every experiment on record

<img alt="The memory viewer: a project's mission, status, experiment and knowledge files, with one experiment record open on its run command and results" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/memory.png">

Each experiment lands in project memory as its own Markdown record: what was run, what was
observed, what was concluded, and what should change next. Findings that hold up become knowledge
entries, and patterns across experiments get records of their own. The **Memory** view browses all
of it beside the sessions. [Memory →](https://fangxm233.github.io/cortex-agent/memory/)

### Training across all your machines

<p align="center"><img width="560" alt="The machines menu with live CPU, memory, disk and per-GPU telemetry" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/machines.png"></p>

Your GPUs, data, and tools rarely live on one box. Run `cortex-client` on any Linux, macOS, or
Windows machine and the agent can read, write, and execute there from the same session. That is
what an agent needs to manage model training: it checks which machine has free GPUs, launches the
run, arms a **waitpoint**, and ends its turn. When the job reports back, the session wakes with the
result, records it as an experiment, and plans the next run, with no polling in between. The
**Machines** menu shows you the same picture live: each machine's CPU, memory, disk, and per-GPU
load and processes. In the desktop app, the dock opens a development server running on a remote
machine as if it ran locally.
[Cross-machine →](https://fangxm233.github.io/cortex-agent/cross-machine/) · [Waitpoints →](https://fangxm233.github.io/cortex-agent/waitpoints/)

### Skills and code the agents improve

Cortex's behavior is set by plain files: skills, rules, hooks, prompts, and agent roles under
`$CORTEX_HOME`, each able to override its built-in counterpart. Agents read and rewrite them like
any other file, and you edit the same skills in Settings. Execution environments choose which
plugins, rules, and tools a session gets, so variants of an agent can run side by side. Pointed at a
source checkout through `CORTEX_REPO`, Cortex rebuilds, reinstalls, and restarts itself when its
code changes. Together these let agents improve the skills and code they run on, while your safety
boundary decides which of those changes wait for your sign-off. This is how Cortex itself is built:
agents working in Cortex write, test, and rebuild the code in this repository.
[Skills & plugins →](https://fangxm233.github.io/cortex-agent/skills-and-plugins/) · [Configuration →](https://fangxm233.github.io/cortex-agent/configuration/)

### On your phone

<img alt="The Android app: the session list, a lead session with decisions and workers, and a plan waiting for approval" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/mobile-strip.png">

The Android app has the same sessions, boards, approvals, and memory in a phone layout. It can
notify you in the background when a turn finishes or when a session is waiting for your answer.
[Desktop and Android apps →](https://fangxm233.github.io/cortex-agent/desktop-app/)

### Integrate with your workflow

Cortex connects to Slack and Feishu (Lark), so you can work with it from the chat app you already
use: start and continue sessions there, and get notified when work finishes or needs you.
[Slack setup →](https://fangxm233.github.io/cortex-agent/slack-setup/) · [Quickstart →](https://fangxm233.github.io/cortex-agent/quickstart/)

### Bring your own models

<p align="center"><img width="640" alt="Model providers: a connected OpenAI Codex login and the catalog of providers to add with an API key or OAuth" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/provider-setup.png"></p>

Cortex drives a coding agent instead of calling a model API itself. PI ships inside the server and
signs in to dozens of providers, including subscriptions such as ChatGPT Plus/Pro, with OAuth or an
API key. Claude Code is optional and uses your own Claude login. Usage and cost are tracked per
session and per provider. [Backends →](https://fangxm233.github.io/cortex-agent/backends/)

### The pelican test

The classic prompt, "Generate an HTML of a pelican riding a bicycle", with the same model,
Claude Opus 5.5 at xhigh effort, in Cortex and in the Claude app.

<table>
  <tr><th>Cortex</th><th>Claude app</th></tr>
  <tr>
    <td><img width="400" alt="Cortex's result: a pelican with a red scarf riding a teal bicycle with a fish basket along a road, with speed, brake and bell controls below the scene" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/pelican-cortex.png"></td>
    <td><img width="400" alt="The Claude app's result: a pelican riding a red bicycle along a road under a sun and clouds" src="https://raw.githubusercontent.com/fangxm233/cortex-agent/main/docs/images/ui/pelican-claude-app.png"></td>
  </tr>
</table>

## Get started

### Desktop app

[Download](#download) the app for your platform, open it, and choose **Install Cortex**. The app
unpacks its own Node.js runtime, installs the server into a private prefix under `~/.cortex`, starts
it, and opens provider setup. Sign in to a provider, pick a default model, and enter the
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
server's address and a one-time pairing code from `cortex ui pair`. [Quickstart →](https://fangxm233.github.io/cortex-agent/quickstart/)

Cortex sends anonymous crash reports and usage statistics, never conversations, files or names.
`cortex init` and the desktop setup offer the choice, and **Settings → Privacy** turns it off.
[Telemetry →](https://fangxm233.github.io/cortex-agent/telemetry/)

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

Cortex gives agents real tools: shell, files, GPUs, other machines, and the files that define
their own behavior. Its guard rails are conversational rather than a sandbox:

- **Plan approval.** Non-trivial work starts with a plan that waits until you approve it or send
  it back for changes.
- **Questions and decisions.** Agents ask through cards that you answer in place, and record the
  choices they make on their own as decisions you can review.
- **Your rules.** A safety boundary in your `$CORTEX_HOME/AGENTS.md` tells every session what it may
  do alone, what needs sign-off (changing a skill's behavior or Cortex's own code, for example), and
  what is forbidden. Operations that need sign-off wait in the **Approval Center**.

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
| [Backends](https://fangxm233.github.io/cortex-agent/backends/) | Claude Code and PI, providers, model selection, cost reporting, subagents |
| [Configuration](https://fangxm233.github.io/cortex-agent/configuration/) | `config/.env`, `settings.json`, models and favorites, execution environments |
| [CLI reference](https://fangxm233.github.io/cortex-agent/cli-reference/) | `cortex`, `cortex-browser`, `cortex-signal`, and `cortex-hook` |
| [Skills & plugins](https://fangxm233.github.io/cortex-agent/skills-and-plugins/) | Writing, overriding, and packaging skills |
| [Safety & approvals](https://fangxm233.github.io/cortex-agent/safety-and-approvals/) | The safety boundary, approval queue, and interactive cards |
| [Hooks](https://fangxm233.github.io/cortex-agent/hooks/) | Hook lifecycle, built-in hooks, and custom hooks |
| [Waitpoints](https://fangxm233.github.io/cortex-agent/waitpoints/) | Waiting on external jobs without polling |
| [MCP](https://fangxm233.github.io/cortex-agent/mcp/) | Cortex's MCP tools and third-party servers |
| [Cross-machine](https://fangxm233.github.io/cortex-agent/cross-machine/) | Deploying `cortex-client` and using remote tools |
| [Agent browser](https://fangxm233.github.io/cortex-agent/agent-browser/) | The Chrome agents drive with `cortex-browser`, watching it live, and taking over |
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
