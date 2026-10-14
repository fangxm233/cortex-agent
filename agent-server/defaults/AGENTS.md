# Cortex

This is your Cortex data directory. Cortex is an autonomous agent system for long-running projects.

## Directory Structure

- `config/` — Settings, budgets, environments, and MCP isolation
- `plugins/`, `hooks/`, `rules/`, `prompts/`, `config/hooks/`, `config/agents/` — Your own plugins, hooks, rules, prompts and agent roles. Built-in ones are read from the Cortex install; a file here with the same name replaces the built-in one, and deleting it restores the built-in.
- `data/` — Persistent store for JSON state & config files
- `logs/` — Runtime logs
- `tmp/` — Workspace for session artifacts and tool results
- `projects/` — Project directories (one subdirectory per active project)
- `user/` — User preferences

## Usage

Run `cortex start` to launch the server, or `cortex daemon` for daemon mode.

<!-- cortex:docs v2 -->
# Cortex documentation
For how to use Cortex — sessions, scheduling, memory, skills, safety & approvals — consult the docs: https://fangxm233.github.io/cortex-agent/
<!-- /cortex:docs -->
