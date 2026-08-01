# Cortex

This is your Cortex data directory. Cortex is an autonomous agent system for long-running projects.

## Directory Structure

- `config/` — Shipped budgets, hooks, MCP isolation, and thread templates, including the hook-free benchmark coder-review roles
- `data/` — Persistent store for JSON state & config files
- `logs/` — Runtime logs
- `tmp/` — Workspace for thread artifacts and tool results
- `projects/` — Project directories (one subdirectory per active project)
- `user/` — User preferences

## Usage

Run `cortex start` to launch the server, or `cortex daemon` for daemon mode.

<!-- cortex:docs v1 -->
# Cortex documentation
For how to use Cortex — tasks, threads, scheduling, memory, skills, safety & approvals — consult the docs: https://fangxm233.github.io/cortex-agent/
<!-- /cortex:docs -->
