# Configuration

Cortex loads all configuration from `$CORTEX_HOME/config/` at startup. The
only required variables are `CORTEX_PLATFORM` and the platform credentials
(Slack). Everything else has sensible defaults and most users
never touch them.

## File hierarchy

All paths below are relative to `$CORTEX_HOME` (default: `~/.cortex/`).

```
$CORTEX_HOME/
├── .env                          # Platform tokens, feature flags
├── config/
│   ├── .env                      # Same file (symlinked / canonical location)
│   ├── profiles.json             # Named agent profiles
│   ├── thread-templates.json     # Agent definitions and orchestration templates
│   ├── machines.json             # Machine registry for remote clients
│   ├── budget.json               # Daily/monthly budget limits
│   ├── mcp-config.json           # Full MCP server configuration
│   ├── mcp-config-core.json      # Core-only MCP (remote_* tools)
│   ├── mcp-config-tui.json       # TUI-mode MCP configuration
│   └── session-hooks.json        # Session-level hook configuration
├── data/
│   ├── mode.json                 # Current runtime mode and profile
│   ├── schedules.json            # Persistent scheduled task list
│   ├── executions.json           # Unified execution registry
│   ├── costs.jsonl               # 90-day rolling cost records
│   └── sessions.json             # Channel-to-agent session mapping
├── .claude/
│   └── settings.json             # Claude Code hooks and permissions
├── hooks/                        # Hook scripts (.mjs)
├── plugins/                      # Role-scoped skill plugins
├── prompts/                      # System prompts, directives, templates
├── rules/                        # Context rules for agent sessions
├── context/                      # Dense Context knowledge repository
│   └── projects/                 # Research project files
├── logs/                         # Daemon and LLM session logs
└── tmp/                          # Temporary workspaces (threads, etc.)
```

## Loading order and precedence

1. **Built-in defaults** (`agent-server/defaults/`) ship with the npm
   package and provide fallback values for every config file.
2. **`$CORTEX_HOME/config/.env`** is loaded at daemon startup via
   `dotenv`. These override the process environment for the daemon and
   all forked child processes.
3. **`$CORTEX_HOME/config/profiles.json`** is read on every agent
   spawn to resolve model, backend, and extra environment.
4. **`$CORTEX_HOME/.claude/settings.json`** is read by Claude Code
   (not by Cortex directly) to configure hooks and permissions for the
   coding-agent backend.

The `.env` file supports standard `KEY=VALUE` syntax and `#` comments.
Environment variables already set in the shell take precedence over the
`.env` file (dotenv default behavior).

## Environment variables

All values are loaded from the `.env` file at `$CORTEX_HOME/config/.env`.
Only `CORTEX_PLATFORM` and your platform credentials are required.

### Paths

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_HOME` | `~/.cortex/` | User data root (config, context, logs, store) |
| `CORTEX_PROJECTS_DIR` | `<CORTEX_HOME>/context/projects/` | Override project directory |
| `CORTEX_REPO` | — | Repo path for daemon auto-rebuild / hot-reload |

### Startup

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_MACHINE` | `os.hostname()` | Machine label for startup DM |
| `CORTEX_RESTART_REASON` | — | Reason string for restart notification |
| `CORTEX_CLIENT_PORT` | `3002` | WebSocket port for cortex-client manager |

### Platform

`CORTEX_PLATFORM` selects the messaging platform(s). It accepts a single value
(`slack`, `feishu`) or a **comma-separated list** to run several at once
(`slack,feishu`). Each platform whose credentials are present is brought online;
the optional TUI gateway (`CORTEX_TUI`) is added on top. With multiple platforms,
messages route by platform and system notices fan out to each platform's admin
channel.

| Variable | Required | Purpose |
|---|---|---|
| `CORTEX_PLATFORM` | yes | `slack` (default). Comma list for multi-platform, e.g. `slack,feishu` |
| `SLACK_BOT_TOKEN` | for slack | Slack Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | for slack | Slack app signing secret |
| `SLACK_APP_TOKEN` | for slack | Slack app-level token for Socket Mode (`xapp-...`) |
| `FEISHU_APP_ID` | for feishu | Feishu app ID (`cli_...`) |
| `FEISHU_APP_SECRET` | for feishu | Feishu app secret |
| `FEISHU_ENCRYPT_KEY` | no | Feishu event encrypt key (optional with long-connection) |
| `FEISHU_VERIFICATION_TOKEN` | no | Feishu event verification token (optional) |
| `FEISHU_DOMAIN` | no | `feishu` (default) or `lark` for the international edition |
| `FEISHU_CHANNEL` | no | Feishu channel ID (auto-set by session) — identifies the current Feishu conduit for MCP tools |
| `CORTEX_ADMIN_CHANNEL` | no | Default admin channel for system notices (Slack DM auto-detected at runtime) |
| `SLACK_ADMIN_CHANNEL` | no | Per-platform admin channel override (falls back to `CORTEX_ADMIN_CHANNEL`) |
| `FEISHU_ADMIN_CHANNEL` | no | Per-platform admin chat_id (`oc_...`); falls back to `CORTEX_ADMIN_CHANNEL` |

### API

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key for direct-API mode |
| `ANTHROPIC_BASE_URL` | Override API base URL (auto-set by gateway proxy) |

### Rate limiting (Slack)

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_SLACK_RL_GLOBAL_CAPACITY` | `20` | Global API call bucket capacity |
| `CORTEX_SLACK_RL_GLOBAL_REFILL_PER_SEC` | `1` | Global refill rate per second |
| `CORTEX_SLACK_RL_CHANNEL_CAPACITY` | `1` | Per-channel bucket capacity |
| `CORTEX_SLACK_RL_CHANNEL_REFILL_PER_SEC` | `1` | Per-channel refill rate per second |

### Webhook

| Variable | Default | Purpose |
|---|---|---|
| `WEBHOOK_PORT` | `3001` | Webhook HTTP server port |
| `WEBHOOK_HOST` | `127.0.0.1` | Fallback host for remote clients (when Tailscale/LAN IP not detected) |
| `GITHUB_WEBHOOK_SECRET` | — | GitHub webhook HMAC-SHA256 signing secret |

### Data file overrides

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_EXECUTIONS_FILE` | `<STORE_DIR>/executions.json` | Execution records |
| `CORTEX_COSTS_FILE` | `<STORE_DIR>/costs.jsonl` | Cost tracking |
| `CORTEX_BUDGET_FILE` | `<CONFIG_DIR>/budget.json` | Budget configuration |

### Feature flags

| Variable | Default | Purpose |
|---|---|---|
| `DEBUG` | — | Enable server-wide debug mode. In addition to debug-level logs, the desktop transcript shows hover inspectors for the exact agent message and each tool call's complete input/result. Any non-empty value enables it; restart agent-server after changing it |
| `CORTEX_DEBUG_TOOL_WARNING_CHARS` | `10000` | In DEBUG transcripts, mark a tool-name badge amber when its formatted complete parameters plus complete result strictly exceed this Unicode character count. Positive integers only; invalid values use the default. Restart agent-server after changing it |
| `CORTEX_EVENT_LOG` | `on` | Set to `off` to disable event-bus logging |
| `CORTEX_SHOW_TOOL_CALLS` | — | Inline tool-call rendering in VirtualMessage tails |
| `CORTEX_DISABLE_USER_CONTEXT` | — | Set to `1` to disable injecting `USER.md` context into direct conversation turns (injected by default; multi-agent thread steps never receive it) |
| `CORTEX_GPU_MONITOR_MOCK` | — | Mock GPU data JSON for testing (overrides real nvidia-smi queries) |
| `CORTEX_SERVER_UPDATE_DISABLE` | — | Set to `1` to disable the server auto-update check (enabled by default) |
| `CORTEX_NOTIFY_COMPACTION` | — | Set to `1` to post a chat notice when an agent's context is compacted. Covers the Claude Code (print mode) and pi backends; the notice names the trigger and, for Claude Code, the pre-compaction token count |
| `CORTEX_TURN_NOTIFY` | `on` | When a long-running turn finishes, Cortex posts a fresh message to the conversation so you get a push notification (the inline status seals to "✓ Done" with an edit, which Slack and Feishu do not notify on). Both success and failure are announced. Set to `0`/`false`/`off`/`no` to disable |
| `CORTEX_TURN_NOTIFY_THRESHOLD_S` | `60` | Minimum turn duration, in seconds, before a completion notification is posted. Shorter turns stay quiet |
| `CORTEX_AUTO_RESUME` | `on` | When a usage-limit window resets, Cortex automatically continues the conversations and threads that the limit interrupted, injecting a note to pick up where they left off. Set to `0`/`false` to leave interrupted work paused for manual continuation |

`DEBUG` persists unabridged prompts, tool parameters, and tool results in per-session conversation-history files. These values can contain secrets, private file contents, or large outputs, and storage grows with their full size. Enable this mode only on a trusted development server and turn it off when inspection is complete. Turning it off immediately removes debug fields and buttons from transcript responses, but it does not delete records captured earlier.

### Task dispatch

| Variable | Default | Purpose |
|---|---|---|
| `TASK_DISPATCH_MAX_CONCURRENT` | `max(4, cpus - 2)` | Max number of task-dispatch threads allowed to run concurrently. A positive integer is used as-is (explicit override). When unset (or invalid), it auto-resolves to `max(4, os.cpus().length - 2)` — scaling to all-but-2 cores, floored at 4. Resolved once at daemon startup; requires a restart to change. |

## profiles.json

Located at `$CORTEX_HOME/config/profiles.json`. Defines named agent profiles
that control which backend, model, and extra configuration each agent session
uses. For a comparison of available backends, see
[backends.md](./backends.md).

### Schema

```json
{
  "defaultProfile": "plan",
  "profiles": {
    "plan": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude",
      "mode": "plan",
      "claudeBackend": "print",
      "extraEnv": {},
      "extraOption": {},
      "fallback": []
    },
    "execute": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude",
      "mode": "execute",
      "claudeBackend": "print",
      "extraEnv": {},
      "extraOption": {}
    }
  }
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `defaultProfile` | string | yes | Name of the default profile when none is specified |
| `profiles` | object | yes | Map of profile name to profile entry |
| `profiles.<name>.model` | string | yes | Model identifier (e.g. `claude-sonnet-4-20250514`) |
| `profiles.<name>.backend` | string | no | Backend: `claude`, `pi`, or `codex` (default: `claude`) |
| `profiles.<name>.mode` | string | no | Operational mode identifier (free-form, e.g. `plan`, `execute`) |
| `profiles.<name>.extraEnv` | object | no | Extra environment variables passed to the backend process. Keys must match `^[A-Z_][A-Z0-9_]*$`. |
| `profiles.<name>.extraOption` | object | no | Extra CLI flags passed to the backend. Keys must start with `--`. |
| `profiles.<name>.claudeBackend` | string | no | Claude adapter mode: `print` (default, uses `-p` + stream-json) or `tui` (interactive Claude under tmux + jsonl tail). Ignored for non-claude backends. |
| `profiles.<name>.thinking` | string | no | Thinking level, in the backend's native value set: for `claude` one of `low`/`medium`/`high`/`xhigh`/`max` (passed as `--effort`), for `pi` one of `off`/`minimal`/`low`/`medium`/`high`/`xhigh` (passed as `--thinking`). Not supported for `codex`. Absent → no flag is passed. Fallback entries do not inherit it — each declares its own. |
| `profiles.<name>.fallback` | array | no | Ordered list of fallback profile entries. If the primary backend fails, Cortex tries each fallback in order. Each fallback inherits unspecified fields from the primary. |

### Profile resolution

At agent spawn time, Cortex resolves the profile through this chain:

1. If a profile name is explicitly provided (via `--profile` or thread
   template), use it.
2. Otherwise, use `defaultProfile` from `profiles.json`.
3. The resolved profile supplies `model`, `backend`, `mode`, `extraEnv`,
   `extraOption`, `claudeBackend`, and `thinking`.
4. If the backend call fails with a transient error, Cortex iterates
   through the `fallback` array (if any), trying each entry in order.

### Validation rules

Profile names must match `^[a-zA-Z0-9_-]+$`. Backend must be one of
`claude`, `codex`, or `pi`. `claudeBackend` must be `print` or `tui`
if specified. `thinking`, if specified, must be a value from the entry's
backend value set (see the fields table); declaring it on a `codex`
profile is an error. Unknown fields are silently ignored.

## settings.json

Located at `$CORTEX_HOME/.claude/settings.json`. This file configures
Claude Code's hook and permission system. Cortex seeds it from
`defaults/.claude/settings.json` during `cortex init` and never
overwrites it on subsequent runs.

The file follows Claude Code's settings format with `hooks` and
`permissions` sections. See [hooks.md](./hooks.md) for the hook
system documentation.

## defaults/config/ layout

The `agent-server/defaults/` directory in the npm package contains
shipped defaults that are copied to `$CORTEX_HOME/` during init:

| Source | Destination | Overwrite behavior |
|---|---|---|
| `defaults/CORTEX.md` | `$CORTEX_HOME/CORTEX.md` | Never |
| `defaults/gitignore` | `$CORTEX_HOME/.gitignore` | Never |
| `defaults/.claude/settings.json` | `$CORTEX_HOME/.claude/settings.json` | Never |
| `defaults/config/budget.json` | `$CORTEX_HOME/config/budget.json` | Only with `--force` |
| `defaults/config/thread-templates.json` | `$CORTEX_HOME/config/thread-templates.json` | Only with `--force` |
| `defaults/config/session-hooks.json` | `$CORTEX_HOME/config/session-hooks.json` | Only with `--force` |
| `defaults/prompts/` | `$CORTEX_HOME/prompts/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/plugins/` | `$CORTEX_HOME/plugins/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/rules/` | `$CORTEX_HOME/rules/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/hooks/` | `$CORTEX_HOME/hooks/` | Per-file: never overwrite unless `--force` |
| `defaults/data/schedules.json` | `$CORTEX_HOME/data/schedules.json` | Never (unless `--force`) |
| `defaults/context/` | `$CORTEX_HOME/context/` | Scaffold files: never overwrite |

This design means npm package upgrades automatically deliver new prompts,
plugins, rules, and hooks without overwriting user customizations.
Config files (`thread-templates.json`, `budget.json`, etc.) require
`--force` to replace.

## Hot-reload behavior

- **`schedules.json`** — watched via file watcher. Changes are picked up
  within seconds without restart. See [scheduling.md](./scheduling.md)
  for the full scheduling system.
- **`profiles.json`** — read fresh on every agent spawn. No restart needed
  to change profiles.
- **`thread-templates.json`** — read fresh on every thread launch.
- **`.env`** — requires a daemon restart to pick up changes (loaded once
  at startup via dotenv).
- **Hook scripts (`hooks/*.mjs`)** — read fresh on every hook invocation.
- **Plugins, prompts, rules** — read fresh on each agent session spawn.

## Where each file lives

| File | Purpose | Path |
|---|---|---|
| `.env` | Environment variables | `$CORTEX_HOME/config/.env` |
| `profiles.json` | Agent profiles | `$CORTEX_HOME/config/profiles.json` |
| `thread-templates.json` | Thread definitions | `$CORTEX_HOME/config/thread-templates.json` |
| `machines.json` | Machine registry | `$CORTEX_HOME/config/machines.json` |
| `budget.json` | Budget limits | `$CORTEX_HOME/config/budget.json` |
| `mcp-config.json` | MCP server config | `$CORTEX_HOME/config/mcp-config.json` |
| `settings.json` | Claude hooks/permissions | `$CORTEX_HOME/.claude/settings.json` |
| `mode.json` | Runtime mode | `$CORTEX_HOME/data/mode.json` |
| `schedules.json` | Scheduled tasks | `$CORTEX_HOME/data/schedules.json` |
| `session-hooks.json` | Session hooks | `$CORTEX_HOME/config/session-hooks.json` |
