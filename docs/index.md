# Cortex

An agent workbench for auto research, self-improvement loops, and other work that runs for days. You give it a mission with a success criterion. It plans the work, runs it with a team of agents across your machines and GPUs, keeps every result as plain files in your project, and checks the outcome against what you agreed, asking you only when a decision is yours to make.

![The Cortex workbench: projects and sessions, a lead session reporting results, and its board in the dock](images/ui/hero-light.png)

## Why Cortex?

A coding agent in a terminal is built around one session: one task, one machine, done within the hour. Auto research and recursive self-improvement (RSI) need more. A study runs for days and outlives every session in it. Its results have to be kept and compared run after run. The work splits among several agents, and the experiments run on GPU servers rather than on the machine the agent started from.

Cortex runs coding agents (Claude Code, or PI with the provider you already pay for) as a long-lived service built for that kind of work:

- **Work continues across sessions** — mission, status, and decisions live as plain files rather than in a chat history that accumulates and decays, so a new session picks up where the last one stopped.
- **Results are kept** — every experiment is its own record of what ran, what came out, and what it means; confirmed findings and cross-experiment patterns collect beside them ([Memory](memory.md)).
- **Agents work as a team** — a lead hands bounded pieces to subagents and persistent workers that start with a fresh context, and keeps a live board of where the work stands ([Team Mode](team.md)).
- **Agents manage model training across your machines** — they check which GPUs are free, launch training and evaluation runs on any connected machine, and wait on them without polling ([Cross-Machine](cross-machine.md), [Waitpoints](waitpoints.md)).
- **The setup itself can improve** — skills, rules, hooks, and Cortex's own source are files the agents can change, inside a safety boundary you write. Cortex itself is developed entirely inside Cortex.

## How Cortex compares

Cortex does not replace Claude Code, Codex, or PI. It runs them as a long-lived service: work that lasts for days, GPU servers across machines, and fewer tokens spent along the way. Claude Code and PI are its backends and run on the subscriptions you already have, including a ChatGPT plan through PI.

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

## Features

- **Plans and approvals** — non-trivial work starts from a plan you approve; questions, decisions, and operations that need sign-off arrive as cards you answer in place ([Safety & Approvals](safety-and-approvals.md)).
- **Subagents and team mode** — bounded work goes to subagents with a clean context; with team mode on, a session can lead persistent worker sessions ([Team Mode](team.md)).
- **Boards for long work** — a long task keeps a live status page beside the conversation, showing its state, plan, what needs you, and the decisions taken ([Boards](team.md#boards)).
- **Structured project log** — every project keeps mission, roadmap, status, experiments, knowledge, patterns, and decisions as plain files ([Memory](memory.md)).
- **Scheduling and waitpoints** — schedule Cortex to scan, digest, or sweep on a recurring basis, and let a waitpoint wake a session when a training run, build, or evaluation it launched finishes ([Scheduling](scheduling.md), [Waitpoints](waitpoints.md)).
- **One agent across your machines** — connect any Mac, Windows, or Linux machine via `cortex-client`; the workbench shows each machine's CPU, memory, disk, and per-GPU load and processes ([Cross-Machine](cross-machine.md)).
- **Editable skills and plugins** — skills are plain `SKILL.md` files that Cortex and you can write, override, or revert, on disk or from **Settings → Plugins**; execution environments choose which plugins, rules, and tools each session gets ([Skills & Plugins](skills-and-plugins.md), [Configuration](configuration.md#execution-environments)).
- **Rebuilds itself from source** — with `CORTEX_REPO` pointing at a source checkout, Cortex rebuilds, reinstalls, and restarts itself when its code changes ([Hot rebuild](architecture.md#hot-rebuild-published-progress-and-the-turn-hold)).
- **A browser the agent drives** — agents open, read and operate web pages in a Chrome on the server or on your own machine; you watch it live and take over for logins ([Agent Browser](agent-browser.md)).
- **Web, native app, chat, and terminal access** — use the browser workbench, Linux/macOS/Windows desktop app, Android app, Slack, Feishu, or TUI against the same server. The workbench shows sessions, workers, boards, approvals, machines, and project memory side by side.

## Ways to use Cortex

| Interface | Best for | Guide |
|---|---|---|
| Browser workbench | Access from an existing browser without installing a client | [Browser Access](browser-access.md) |
| Desktop app | Native Linux, macOS, or Windows workbench | [Desktop and Android Apps](desktop-app.md) |
| Android app | Mobile sessions, projects, and approvals | [Desktop and Android Apps](desktop-app.md) |
| Slack or Feishu | Chat-driven operation and notifications | [Quickstart](quickstart.md) |
| TUI | Full-screen terminal operation | [CLI Reference](cli-reference.md) |

## Quickstart

The [desktop app](desktop-app.md#installing-a-server-from-the-app) installs and starts a Cortex server on macOS, Linux, or Windows without a terminal. From a terminal:

```bash
npm install -g @cortex-agent/server
cortex init
cortex ui enable
cortex daemon
```

See [Quickstart](quickstart.md) for detailed server and chat-platform setup. Once the server is running, open the workbench at `http://127.0.0.1:3004` on the server, use [Browser Access](browser-access.md) to reach it from elsewhere, or connect a native client as described in [Desktop and Android Apps](desktop-app.md).
