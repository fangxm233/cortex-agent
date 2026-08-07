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
│   ├── settings.json             # Runtime behavior settings (hot-reloaded)
│   ├── profiles.json             # Named agent profiles
│   ├── thread-templates/         # Thread config — one JSON per agent/template/shell
│   ├── machines.json             # Machine registry for remote clients
│   ├── budget.json               # Daily/monthly budget limits
│   ├── mcp-config.json           # Direct-session MCP configuration
│   ├── mcp-config-core.json      # Remote execution/time layer
│   ├── mcp-config-tasks.json     # Read-only task-monitoring layer
│   ├── mcp-config-manager-qa.json # Shared manager-answer layer
│   ├── mcp-config-thread.json    # Thread-control layer
│   ├── mcp-config-tui.json       # TUI interaction layer
│   └── hooks/                    # Hook registry — one JSON declaration per hook
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
3. **`$CORTEX_HOME/config/settings.json`** holds the runtime behavior
   settings. It is read at the point of use and hot-reloaded on change.
   For every key it defines, it overrides the legacy environment
   variable of the same setting.
4. **`$CORTEX_HOME/config/profiles.json`** is read on every agent
   spawn to resolve model, backend, and extra environment.
5. **`$CORTEX_HOME/.claude/settings.json`** is read by Claude Code
   (not by Cortex directly) to configure hooks and permissions for the
   coding-agent backend.

The `.env` file supports standard `KEY=VALUE` syntax and `#` comments.
Environment variables already set in the shell take precedence over the
`.env` file (dotenv default behavior).

## Environment variables

All values are loaded from the `.env` file at `$CORTEX_HOME/config/.env`.
Only `CORTEX_PLATFORM` and your platform credentials are required.

Server behavior settings no longer live here: they moved to
[`config/settings.json`](#configsettingsjson), where they hot-reload instead of
requiring a restart. Their old variables still work as a deprecated fallback and
are migrated out of `.env` automatically on the next daemon start.

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

The admin channels for system notices are settings, not environment variables:
see `adminChannel` and `feishuAdminChannel` in
[`config/settings.json`](#configsettingsjson). The legacy variables
`SLACK_ADMIN_CHANNEL`, `CORTEX_ADMIN_CHANNEL`, and `FEISHU_ADMIN_CHANNEL` are
still read as a deprecated fallback.

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
| `CORTEX_GPU_MONITOR_MOCK` | — | Mock GPU data JSON for testing (overrides real nvidia-smi queries) |

The event log, tool-call rendering, user-context injection, update check,
compaction notice, turn notification, and auto-resume switches are now settings
keys — see [`config/settings.json`](#configsettingsjson).

`DEBUG` persists unabridged prompts, tool parameters, and tool results in per-session conversation-history files. These values can contain secrets, private file contents, or large outputs, and storage grows with their full size. Enable this mode only on a trusted development server and turn it off when inspection is complete. Turning it off immediately removes debug fields and buttons from transcript responses, but it does not delete records captured earlier.

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
| `profiles.<name>.backend` | string | no | Backend: `claude` or `pi` (default: `claude`) |
| `profiles.<name>.mode` | string | no | Operational mode identifier (free-form, e.g. `plan`, `execute`) |
| `profiles.<name>.extraEnv` | object | no | Extra environment variables passed to the backend process. Keys must match `^[A-Z_][A-Z0-9_]*$`. |
| `profiles.<name>.extraOption` | object | no | Extra CLI flags passed to the backend. Keys must start with `--`. |
| `profiles.<name>.claudeBackend` | string | no | Claude adapter mode: `print` (default, uses `-p` + stream-json) or `tui` (interactive Claude under tmux + jsonl tail). Ignored for non-claude backends. |
| `profiles.<name>.thinking` | string | no | Thinking level, in the backend's native value set: for `claude` one of `low`/`medium`/`high`/`xhigh`/`max` (passed as `--effort`), for `pi` one of `off`/`minimal`/`low`/`medium`/`high`/`xhigh` (passed as `--thinking`). Absent → no flag is passed. Fallback entries do not inherit it — each declares its own. |
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

Profile names must match `^[a-zA-Z0-9_-]+$`. Backend must be `claude`
or `pi`. `claudeBackend` must be `print` or `tui` if specified.
`thinking`, if specified, must be a value from the entry's backend value
set (see the fields table). Unknown fields are silently ignored.

## config/settings.json

Located at `$CORTEX_HOME/config/settings.json`. This file holds the **runtime
behavior settings** of the server: switches and limits that used to be
environment variables and needed a daemon restart to change. Editing this file
takes effect without a restart.

It is a flat JSON object that stores **only the keys you explicitly override**.
Any key you leave out falls back to its legacy environment variable, and then to
the built-in default. The file itself is optional — a fresh install has none and
runs entirely on defaults. It is created the first time something writes it: the
startup migration below, admin-channel auto-detection, or the Web workbench
settings panels.

```json
{
  "turnNotify": false,
  "waitingSweepMs": 30000,
  "uiCorsOrigins": ["cortexui://localhost"]
}
```

Values are type-checked against the schema below when the file is read. A key
whose JSON type does not match rejects the whole file: at startup Cortex falls
back to environment variables and defaults, and on a reload it keeps the last
valid settings. Either way the reason is logged. Unknown keys are ignored.

### Keys

| Key | Type | Default | Effect | Legacy env variable |
|---|---|---|---|---|
| `turnNotify` | boolean | `true` | When a long-running turn finishes, post a fresh message to the conversation so you get a push notification (the inline status seals to "✓ Done" with an edit, which Slack and Feishu do not notify on). Both success and failure are announced | `CORTEX_TURN_NOTIFY` |
| `turnNotifyThresholdS` | number | `60` | Minimum turn duration, in seconds, before that completion notification is posted. Shorter turns stay quiet | `CORTEX_TURN_NOTIFY_THRESHOLD_S` |
| `notifyCompaction` | boolean | `false` | Post a chat notice when an agent's context is compacted. Covers the Claude Code (print mode) and pi backends; the notice names the trigger and, for Claude Code, the pre-compaction token count | `CORTEX_NOTIFY_COMPACTION` |
| `showToolCalls` | boolean | `false` | Inline tool-call rendering in VirtualMessage tails | `CORTEX_SHOW_TOOL_CALLS` |
| `statusNewqButton` | boolean | `false` | Show the "New (quiet)" button on status messages (`=!newq`, which skips the pre-close hook) | `CORTEX_STATUS_NEWQ_BUTTON` |
| `autoResume` | boolean | `true` | When a usage-limit window resets, automatically continue the conversations and threads the limit interrupted, injecting a note to pick up where they left off. Set to `false` to leave interrupted work paused for manual continuation | `CORTEX_AUTO_RESUME` |
| `streamDeltas` | boolean | `true` | Stream assistant text token by token. Disable to deliver each assistant message in one piece | `CORTEX_STREAM_DELTAS` |
| `bgContinuation` | boolean | `true` | Forward the output of background tasks back into the conversation when they finish | `CORTEX_BG_CONTINUATION` |
| `eventLog` | boolean | `true` | Write the event bus to the daily rolling JSONL event log | `CORTEX_EVENT_LOG` |
| `diskMonitor` | boolean | `true` | Check free space on the filesystem containing `$CORTEX_HOME` every five minutes and send a system notice below 500 MiB. `false` stops the timer; switching back to `true` runs an immediate check | `CORTEX_DISK_MONITOR` |
| `disableUserContext` | boolean | `false` | Set to `true` to stop injecting `USER.md` context into direct conversation turns (injected by default; multi-agent thread steps never receive it) | `CORTEX_DISABLE_USER_CONTEXT` |
| `serverUpdateDisable` | boolean | `false` | Set to `true` to disable the server auto-update check (enabled by default) | `CORTEX_SERVER_UPDATE_DISABLE` |
| `hooksLegacy` | boolean | `false` | Bypass the hook registry and build Claude hook settings from the fixed built-in table instead. See [hooks.md](./hooks.md) | `CORTEX_HOOKS_LEGACY` |
| `managerRotateSteps` | number | `10` | Steps a manager session runs before it is rotated into a fresh incarnation. See [threads.md](./threads.md) | `CORTEX_MANAGER_ROTATE_STEPS` |
| `waitingSweepMs` | number | `60000` | Interval, in milliseconds, of the disk-driven sweep that reconciles waiting manager threads against on-disk task state. `0` disables the sweep (see the hot-reload exception below) | `CORTEX_WAITING_SWEEP_MS` |
| `injectWaitMaxS` | number | `600` | Upper bound, in seconds, on how long an injected mid-turn message waits for a reply before the busy gate is released. Prevents a wedged process from holding the daemon restart gate forever | `CORTEX_INJECT_WAIT_MAX_S` |
| `threadMaxDepth` | number | `5` | Maximum nesting depth for spawning nested threads; a spawn at or beyond this depth is rejected | `CORTEX_THREAD_MAX_DEPTH` |
| `taskArtifactTemplates` | string[] | `["manager"]` | Templates whose dispatch threads keep their artifact on the task node instead of the temporary workspace | `CORTEX_TASK_ARTIFACT_TEMPLATES` (comma-separated) |
| `taskDispatchMaxConcurrent` | number \| null | `null` | Max number of task-dispatch threads allowed to run concurrently. A number set here is used as-is (use a positive value); `null` keeps the automatic policy `max(4, os.cpus().length - 2)` — all-but-2 cores, floored at 4 | `TASK_DISPATCH_MAX_CONCURRENT` |
| `uiCorsOrigins` | string[] | `[]` | Origins that receive CORS headers from the Web UI HTTP host. See [desktop-app.md](./desktop-app.md) | `CORTEX_UI_CORS_ORIGINS` (comma-separated) |
| `adminChannel` | string \| null | `null` | Slack channel for system notices (startup, rate-limit, disk alerts). The first DM to the bot is auto-detected and persisted here | `SLACK_ADMIN_CHANNEL`, then `CORTEX_ADMIN_CHANNEL` |
| `feishuAdminChannel` | string \| null | `null` | Feishu admin `chat_id` (`oc_...`) for the same notices. Independent of `adminChannel` — Slack channel ids are not usable on Feishu | `FEISHU_ADMIN_CHANNEL` |

The Web workbench writes a subset of these from **Settings → Notifications**
(`turnNotify`, `autoResume`, `notifyCompaction`) and **Settings → Advanced**
(`eventLog`, `diskMonitor`, `showToolCalls`, `disableUserContext`,
`serverUpdateDisable`). Every other key is edited by hand in the file.

### Hot reload

The config directory is watched. A change to `settings.json` is debounced for
300 ms, the file is re-read, and the new values are used from then on — **no
daemon restart**. Two consequences worth knowing:

- Each setting takes effect at its own point of use: the next turn, the next
  agent spawn, the next dispatch cycle, or the next HTTP request. `uiCorsOrigins`
  is resolved per request; `adminChannel` and `feishuAdminChannel` are pushed
  into the running platform adapter as soon as they change. `diskMonitor=false`
  stops its timer, while restoring `true` starts the timer and checks immediately.
- A broken file never takes the server down. Invalid JSON or a type mismatch
  leaves the previous settings in place and logs the error; fix the file and the
  next write reloads it.

**Exception — `waitingSweepMs`.** The waiting-manager sweep re-arms itself after
each run using the current value, so raising or lowering the interval applies
from the next round. Setting it to `0` while the server runs stops the loop for
good: nothing re-arms it, and restoring a positive value later does **not**
restart it. Only a daemon restart does. (A value of `0` at startup means the
loop never starts.)

### Legacy environment variables and deprecation

Every key keeps its old environment variable as a fallback, parsed exactly as it
was before the move — `CORTEX_EVENT_LOG=off`, `CORTEX_TURN_NOTIFY=0`/`false`/`off`/`no`,
`CORTEX_NOTIFY_COMPACTION=1`, comma-separated lists for the two `string[]` keys,
and so on. Precedence is always: key in `settings.json` → legacy variable →
built-in default. For `adminChannel` the original chain is preserved:
`SLACK_ADMIN_CHANNEL` is consulted before `CORTEX_ADMIN_CHANNEL`.

The first time a legacy variable supplies a value, the daemon logs a
deprecation warning naming the variable and the setting it feeds
(`Deprecated env <VAR> supplies settings.<key>; move it to settings.json`). The
fallback exists for compatibility during migration — new configuration belongs
in `settings.json`.

### Automatic migration out of .env

On every daemon start, right after `.env` is loaded, Cortex scans
`$CORTEX_HOME/config/.env` for the legacy variables listed above. If it finds at
least one:

1. `.env` is copied to `.env.bak-<timestamp>` in the same directory, where
   `<timestamp>` is an ISO 8601 instant with `:` and `.` replaced by `-`
   (for example `.env.bak-2026-07-30T09-12-33-482Z`).
2. Each legacy value is parsed with its old semantics and written into
   `settings.json`. A key already present in `settings.json` is never
   overwritten — the file wins over `.env`.
3. The migrated assignments are removed from `.env`, which keeps its original
   file permissions and gains the header comment
   `# Legacy server settings migrated to settings.json; secrets remain in .env.`
4. The dead variable `CORTEX_SERVER_UPDATE_ENABLE`, which nothing reads any
   more, is dropped in the same pass.

The migration is idempotent: a `.env` with no legacy variables is left
untouched, and later starts do nothing. If any step fails, the error is logged,
`.env` is left intact, and the server keeps running on the environment
fallback — so a failed migration costs nothing but the deprecation warnings.

### What stays in .env

Three categories of variables deliberately remain in `.env`:

- **Secrets and credentials** — `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
  `SLACK_APP_TOKEN`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`,
  `ANTHROPIC_API_KEY`, `GITHUB_WEBHOOK_SECRET`, `CORTEX_CLIENT_TOKEN`. They are
  settings in a loose sense, but keeping them out of a file that the Web UI can
  read and write keeps the blast radius small.
- **Variables consumed by child processes** — `CORTEX_HOME`,
  `CORTEX_PROJECTS_DIR`, `WEBHOOK_PORT`, `DEBUG`, `CORTEX_LANG`, and the data
  file overrides. Hooks, MCP servers, the CLI, and `cortex-client` inherit the
  daemon's environment; a server-side JSON file would never reach them.
- **Startup topology** — `CORTEX_PLATFORM`, `CORTEX_MACHINE`, `CORTEX_UI_HTTP`,
  `CORTEX_UI_PORT`, `CORTEX_UI_SPA_DIR`. These decide which adapters and
  listeners exist at boot, so hot-reloading them would have no meaning; they
  require a restart by construction.

### Not the same file as .claude/settings.json

`$CORTEX_HOME/config/settings.json` (this file) configures the **Cortex
server**. `$CORTEX_HOME/.claude/settings.json` configures **Claude Code**'s
hooks and permissions and is read by the Claude CLI, not by Cortex. Same file
name, different directory, different owner, different schema — see the next
section.

## .claude/settings.json (Claude Code)

Located at `$CORTEX_HOME/.claude/settings.json`. This file configures
Claude Code's hook and permission system. Cortex seeds it from
`defaults/.claude/settings.json` during `cortex init` and never
overwrites it on subsequent runs.

The file follows Claude Code's settings format with `hooks` and
`permissions` sections. See [hooks.md](./hooks.md) for the hook
system documentation. It has nothing to do with the Cortex runtime
settings in [`config/settings.json`](#configsettingsjson).

## defaults/config/ layout

The `agent-server/defaults/` directory in the npm package contains
shipped defaults. Most are copied to `$CORTEX_HOME/` during init; the hook
assets and the thread-template entities are additionally re-synced by the
server on every startup:

| Source | Destination | Overwrite behavior |
|---|---|---|
| `defaults/CORTEX.md` | `$CORTEX_HOME/CORTEX.md` | Never |
| `defaults/gitignore` | `$CORTEX_HOME/.gitignore` | Never |
| `defaults/.claude/settings.json` | `$CORTEX_HOME/.claude/settings.json` | Never |
| `defaults/config/budget.json` | `$CORTEX_HOME/config/budget.json` | Only with `--force` |
| `defaults/config/thread-templates/` | `$CORTEX_HOME/config/thread-templates/` | Per-file copy-if-missing, at init and again at every server start: a shipped agent/template/shell file you do not have yet is added; a file you already have is never overwritten — `--force` does not apply to this tree |
| `defaults/config/hooks/` | `$CORTEX_HOME/config/hooks/` | Per-file CalVer sync at every server start: added when missing, refreshed when the shipped `version` is newer. A declaration with no `version` — yours — is never overwritten |
| `defaults/prompts/` | `$CORTEX_HOME/prompts/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/plugins/` | `$CORTEX_HOME/plugins/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/rules/` | `$CORTEX_HOME/rules/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/hooks/` | `$CORTEX_HOME/hooks/` | Per-file at init: never overwrite unless `--force`. At every server start, a shipped script is re-copied unless the deployed file already carries an equal or newer `@cortex-hook-version` |
| `defaults/data/schedules.json` | `$CORTEX_HOME/data/schedules.json` | Never (unless `--force`) |
| `defaults/context/` | `$CORTEX_HOME/context/` | Scaffold files: never overwrite |

This design means npm package upgrades automatically deliver new prompts,
plugins, rules, hooks, and thread-template entities without overwriting user
customizations. Whole-file config such as `budget.json` still requires
`--force` to replace; `config/thread-templates/` is merged per file instead,
so newly shipped entities reach existing installs without touching your edits.

## Hot-reload behavior

Watcher-backed files under `config/` automatically switch to filesystem
snapshot polling every 5 seconds if the watcher cannot start or reports a
runtime error. Each loader keeps the same validation and failure behavior in
polling mode as it uses with filesystem events.

- **`config/settings.json`** — watched via file watcher, debounced 300 ms. New
  values apply at the next point of use without a restart; a broken file keeps
  the previous settings. `waitingSweepMs` set to `0` at runtime is the one
  exception that needs a restart to recover. See
  [config/settings.json](#configsettingsjson).
- **`schedules.json`** — watched via file watcher. Changes are picked up
  within seconds without restart. See [scheduling.md](./scheduling.md)
  for the full scheduling system.
- **`profiles.json`** — cached and watched for parseable JSON changes. An
  update refreshes the cache before the next agent spawn; malformed JSON keeps
  the previous profiles.
- **`machines.json`** — watched and reloaded after valid changes. Invalid
  entries keep the previous machine registry.
- **`thread-templates/`** — each entity subdirectory (`agents/`, `templates/`,
  `shells/`) is watched. Changes are debounced (300ms) and the whole config is
  reloaded without a restart; a legacy single `thread-templates.json` is watched
  the same way until it is migrated. See [threads.md](./threads.md).
- **`.env`** — requires a daemon restart to pick up changes (loaded once
  at startup via dotenv). Behavior settings that used to live here have moved
  to `config/settings.json`, which does not.
- **Hook declarations (`config/hooks/*.json`)** — the registry is re-read on
  every agent spawn, so a new `agent:*` / `cc:*` / `pi:*` entry applies to the
  next agent that starts. `cortex:*` entries are snapshotted at server start
  and need a restart. See [hooks.md](./hooks.md).
- **Hook scripts (`hooks/*.mjs`)** — read fresh on every hook invocation.
- **Plugins, prompts, rules** — read fresh on each agent session spawn.

## Where each file lives

| File | Purpose | Path |
|---|---|---|
| `.env` | Environment variables | `$CORTEX_HOME/config/.env` |
| `settings.json` | Runtime behavior settings (hot-reloaded) | `$CORTEX_HOME/config/settings.json` |
| `profiles.json` | Agent profiles | `$CORTEX_HOME/config/profiles.json` |
| `thread-templates/` | Thread definitions — one JSON per agent/template/shell. Used when present; otherwise the loader falls back to the legacy single file `thread-templates.json`, which is split into this directory by a one-time startup migration | `$CORTEX_HOME/config/thread-templates/` |
| `machines.json` | Machine registry | `$CORTEX_HOME/config/machines.json` |
| `budget.json` | Budget limits | `$CORTEX_HOME/config/budget.json` |
| `mcp-config.json` | MCP server config | `$CORTEX_HOME/config/mcp-config.json` |
| `.claude/settings.json` | Claude Code hooks/permissions (not the Cortex settings file) | `$CORTEX_HOME/.claude/settings.json` |
| `mode.json` | Runtime mode | `$CORTEX_HOME/data/mode.json` |
| `schedules.json` | Scheduled tasks | `$CORTEX_HOME/data/schedules.json` |
| `hooks/*.json` | Hook declarations | `$CORTEX_HOME/config/hooks/` |
