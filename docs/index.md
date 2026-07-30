# Cortex

Autonomous agent system for long-running projects. You give it a mission with a success criterion, and it plans the work, dispatches a pipeline of agents to execute it, keeps a structured log of progress in your repo, and reviews itself before each commit — across days or weeks of unattended work.

## Why Cortex?

Cortex is designed around four failure modes of long agent runs:

- **Context rot** — durable project state lives as plain files in your repo, not chat history that accumulates and decays.
- **Execution drift** — every task carries a verifiable success criterion, checked at completion.
- **Context window limits** — work is partitioned across agent pipelines, each with bounded scope and fresh context.
- **Single-perspective bias** — adversarial review is a built-in pipeline stage, not a polite suggestion.

## Features

- **Mission-driven task system** — hand off a goal; Cortex decomposes it into tracked tasks with priorities, dependencies, and verifiable done-conditions.
- **Multi-agent thread pipelines** — long jobs run as a relay of focused agents instead of one overloaded session.
- **Structured project log** — every project keeps mission, roadmap, status, experiments, knowledge, patterns, and decisions as plain files.
- **Cron and interval scheduling** — schedule Cortex to scan, digest, or sweep on a recurring basis.
- **Self-evolving skills** — Cortex drafts new skills when it catches itself repeating patterns.
- **One agent across your machines** — connect any Mac, Windows, or Linux machine via `cortex-client`.
- **Web, native app, chat, and terminal access** — use the browser workbench, Linux/macOS/Windows desktop app, Android app, Slack, Feishu, or TUI against the same server.

## Ways to use Cortex

| Interface | Best for | Guide |
|---|---|---|
| Browser workbench | Access from an existing browser without installing a client | [Browser Access](browser-access.md) |
| Desktop app | Native Linux, macOS, or Windows workbench | [Desktop and Android Apps](desktop-app.md) |
| Android app | Mobile sessions, threads, tasks, projects, and approvals | [Desktop and Android Apps](desktop-app.md) |
| Slack or Feishu | Chat-driven operation and notifications | [Quickstart](quickstart.md) |
| TUI | Full-screen terminal operation | [CLI Reference](cli-reference.md) |

## Quickstart

```bash
npm install -g @cortex-agent/server
cortex init
cortex daemon
```

See [Quickstart](quickstart.md) for detailed server and chat-platform setup. After the server is running, use [Browser Access](browser-access.md) to expose the Web workbench or [Desktop and Android Apps](desktop-app.md) to connect a native client.
