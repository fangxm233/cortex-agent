# Configuration

Cortex reads configuration from `$CORTEX_HOME/config/`. Messaging integrations
are optional: browser and app sessions can run without a Slack or Feishu bot.
Each enabled messaging platform needs its own credentials.

## File hierarchy

All paths below are relative to `$CORTEX_HOME` (default: `~/.cortex/`).

```
$CORTEX_HOME/
├── .env                          # Platform tokens, feature flags
├── config/
│   ├── .env                      # Same file (symlinked / canonical location)
│   ├── settings.json             # Runtime behavior settings (hot-reloaded)
│   ├── profiles.json             # Named agent profiles
│   ├── environments/             # Execution environments — one JSON per environment
│   ├── machines.json             # Machine registry for remote clients
│   ├── budget.json               # Daily/monthly budget limits
│   ├── mcp-config.json           # Direct-session MCP configuration
│   ├── mcp-config-core.json      # Remote execution/time layer
│   ├── mcp-config-interaction.json # Shared interaction layer
│   └── hooks/                    # Hook registry — one JSON declaration per hook
├── data/
│   ├── mode.json                 # Current runtime mode and profile
│   ├── schedules.json            # Persistent schedule list
│   ├── executions.json           # Unified execution registry
│   ├── costs.jsonl               # 90-day rolling cost records
│   ├── session-registry.jsonl    # Session records, channel bindings, conversation headers + turns (single owner)
│   ├── *.pre-2026.9.14.bak       # Retired sessions.json / conversation-ledger.json, kept one release after migration
│   ├── retention-candidates.json # Two-sweep orphan retention markers
│   └── conversation-history/     # Per-session transcript/history JSONL
├── .claude/
│   └── settings.json             # Cortex-scaffolded Claude Code project settings
├── hooks/                        # Hook scripts (.mjs)
├── plugins/                      # Skill plugins
├── prompts/                      # System prompts, directives, templates
├── rules/                        # Context rules for agent sessions
├── context/                      # Dense Context knowledge repository
│   └── projects/                 # Research project files
├── logs/                         # Daemon and backend session logs
│   ├── sessions/                 # Claude capture logs
│   └── sessions-pi/              # PI transcript bundles
└── tmp/                          # Temporary workspaces
```

## Loading order and precedence

1. **Built-in defaults** (`agent-server/defaults/`) ship with the npm
   package and provide fallback values for every config file.
2. **`$CORTEX_HOME/config/.env`** is loaded at daemon startup via
   `dotenv`. Existing launcher environment variables take precedence over the
   file, and the worker inherits the daemon environment.
3. **`$CORTEX_HOME/config/settings.json`** holds the runtime behavior
   settings. It is read at the point of use and hot-reloaded on change.
   For every key it defines, it overrides the legacy environment
   variable of the same setting.
4. **`$CORTEX_HOME/config/profiles.json`** is read on every agent
   spawn to resolve model, backend, and extra environment.
5. **`$CORTEX_HOME/.claude/settings.json`** is the Cortex-scaffolded
   Claude Code project settings file. Claude Code may also read
   `<spawn cwd>/.claude/settings.local.json`, `<spawn cwd>/.claude/settings.json`,
   and the user settings file at `$CLAUDE_CONFIG_DIR/settings.json`
   (or `~/.claude/settings.json`). Cortex only scaffolds the `$CORTEX_HOME`
   file; the retention helper separately syncs `cleanupPeriodDays` in the
   user file.

The `.env` file supports standard `KEY=VALUE` syntax and `#` comments.
Environment variables already set in the shell take precedence over the
`.env` file (dotenv default behavior).

## Platform settings in the Web UI

**Settings → Platform** provides Feishu/Lark and Slack connection forms in the
browser, desktop app and mobile app. Enable the platform, fill its required
credentials and save. Secrets are write-only: a blank secret field preserves the
saved value, entering a value replaces it, and **Clear saved value** explicitly
queues its removal for the next save. Disabling a platform keeps its credentials.
Credential entry requires HTTPS or a loopback API address; a native app's local
webview origin does not make a remote HTTP server secure.

The configuration check lists missing required fields; it does not test the
connection or account permissions. Connection changes are saved to `config/.env`
and require a **daemon restart**, not just a worker restart. The page compares
saved configuration with the running server environment and marks differences.
If differences remain after restarting the daemon, check its launcher environment
for overriding variables. Saving does not restart any process.

Each card also edits its notification destination (`adminChannel` for Slack,
`feishuAdminChannel` for Feishu). These runtime settings apply to subsequent
notifications. Saving an empty destination clears the route; Feishu may register
a destination automatically on the next first-contact private message.

The Feishu card's **Feishu skills in Web / apps** switch controls
`settings.feishuSkillsInWeb` (default `false`). Enabling it allows `web:` sessions
to load an assigned `cortex-feishu` skill plugin, including desktop and mobile app
sessions. Feishu sessions retain their normal scope; Slack and CLI sessions do
not gain the plugin. Start a new session to verify. Agent plugin assignment,
`lark-cli` login and permissions remain necessary; this setting does not change
Feishu MCP loading or grant account access.

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

**Settings → Profiles** edits this file. There, `provider`, `model` and `mode`
are picked from lists rather than typed: the provider selects a gateway
endpoint, and its models (from the logged-in backends) and routes (from
`gateway.yaml`) follow. Each of the three keeps a **Custom…** entry, and falls
back to a plain text box for an endpoint the server cannot enumerate — the
lists only offer, they never narrow what this file accepts.

### Schema

```json
{
  "defaultProfile": "plan",
  "profiles": {
    "plan": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude",
      "mode": "plan",
      "extraEnv": {},
      "extraOption": {},
      "fallback": []
    },
    "execute": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude",
      "mode": "execute",
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
| `profiles.<name>.extraOption` | object | no | Extra CLI flags passed to the Claude Code backend. Keys must start with `--`. On `pi` only `--thinking` is honored, as an override of the `thinking` field; any other key is logged and ignored, since there is no PI command line to hand it to. |
| `profiles.<name>.thinking` | string | no | Thinking level, in the backend's native value set: for `claude` one of `low`/`medium`/`high`/`xhigh`/`max` (delivered as the `--effort` flag), for `pi` one of `off`/`minimal`/`low`/`medium`/`high`/`xhigh` (delivered as the session's thinking level). Absent → the backend's own default applies. Fallback entries do not inherit it — each declares its own. |
| `profiles.<name>.fallback` | array | no | Ordered list of fallback profile entries. If the primary backend fails, Cortex tries each fallback in order. Each fallback inherits unspecified fields from the primary. |

### Profile resolution

At agent spawn time, Cortex resolves the profile through this chain:

1. If a profile name is explicitly provided (via `--profile`, or by the
   conversation's execution environment naming one), use it.
2. Otherwise, use `defaultProfile` from `profiles.json`.
3. The resolved profile supplies `model`, `backend`, `mode`, `extraEnv`,
   `extraOption`, and `thinking`.
4. A direct session may override `model`, `provider`, `thinking` and `mode`
   on top of that profile, chosen in the Web composer's engine picker and
   stored per channel. Nothing else is overridable — the backend, environment
   and fallback chain stay the profile's. See
   [backends.md](./backends.md#per-session-model-thinking-level-and-route).
5. If the backend call fails with a transient error, Cortex iterates
   through the `fallback` array (if any), trying each entry in order.

### Validation rules

Profile names must match `^[a-zA-Z0-9_-]+$`. Backend must be `claude`
or `pi`. `thinking`, if specified, must be a value from the entry's backend value
set (see the fields table). Unknown fields are silently ignored.

## Execution environments

An execution environment decides how a conversation runs, apart from which
model runs it: the system prompt, the built-in tool list, which plugins load,
which Cortex MCP tools the session gets, and how much ambient context (rules,
hooks, the project block, the backend's own skills) comes with it. Each
environment is one file, `config/environments/<name>.json`, and the file name is
its name.

Cortex ships two:

| Environment | What it is for |
|---|---|
| `main` | General-purpose work on the currently active profile, with the Cortex system, commission, and Feishu plugins. It is the default: a session that has not picked an environment runs in `main`, and `main` cannot be deleted |
| `creative` | A clean-room surface for writing, image prompts, naming, and copy, with the operational context stripped out (see [A minimal surface](#a-minimal-surface)) |

The shipped files are copied into `config/environments/` at `cortex init`, and
again at every server start when they are missing. A file you already have is
never overwritten, so your edits survive upgrades, and a file you add is an
environment like any other. Changes to the directory are picked up about 300 ms
later without a restart. A file that is not valid JSON, or whose `name` does not
match its file name, is skipped and logged.

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Must equal the file name without `.json` |
| `description` | string | no | One line describing what the environment is for, shown in pickers |
| `profile` | string | yes | A profile from `profiles.json`, or `"__active__"` to run on whatever profile the conversation resolves to. A named profile overrides the model for this environment's turns without changing the conversation's own profile |
| `directive` | string | no | Role or identity text prepended to the prompt |
| `systemPrompt` | string | no | Replaces the backend's default system prompt |
| `promptTemplate` | string | no | Wraps each message; `{{input}}` stands for what was sent |
| `claudeAgent` | string | no | Claude Code agent name, passed as `--agent`. Claude only |
| `outputStyle` | string | no | Claude Code output style. Claude only |
| `tools` | string | no | Comma-separated built-in tool list that replaces the backend's default set |
| `pluginDirs` | string[] | no | Plugin directories to load, relative to `$CORTEX_HOME` unless absolute. Absent loads none |
| `mcpComposition` | `"direct"` \| `"none"` | no | `direct` (default) gives the session the Cortex MCP tools; `none` gives it no MCP at all, plugin servers included |
| `mcpToolAllowlist` | string[] | no | Narrows the Cortex MCP tools to the names listed. Absent keeps the full surface |
| `loadRules` | boolean | no | Default `true`: prepend the global rules from `rules/` |
| `disableHooks` | boolean | no | Default `false`. `true` runs the session without lifecycle hooks |
| `skills` | boolean | no | Default `true`. `false` removes the backend's skill layer, including the `Skill` tool |
| `settingSources` | string[] | no | Which Claude setting files to read: any of `user`, `project`, `local`. Absent uses the CLI default; `[]` reads none |
| `projectContext` | boolean | no | Default `true`: tell the session which project it belongs to on its first turn |

The three prompt fields accept `file:<name>` instead of literal text. The text is
then read from `prompts/directives/`, `prompts/systemPrompts/`, or
`prompts/promptTemplates/` respectively; the shipped `main` uses
`"systemPrompt": "file:direct.md"`. A field the schema does not know, a missing
prompt file, or a missing plugin directory is reported as a warning, and the
environment still loads.

### Plugins and the Environments panel

Plugins attach to environments. An environment's `pluginDirs` is the complete
set of plugin directories its sessions load; the environment's Plugins tab
writes that same field, and **Settings → Plugins** shows which environments use
each installed plugin (see
[Skills and Plugins](./skills-and-plugins.md#assigning-plugins)).

In the Web workbench and the desktop app, **Settings → Environments** lists
every environment and edits one at a time: the JSON body with live validation,
a Validation tab for errors and warnings, and a Plugins tab for its plugin set.
A new environment starts from a skeleton that already validates, and an existing
one can be duplicated under a new name. Errors block a save, warnings do not,
and a save made against a file that changed on disk in the meantime is refused
rather than overwriting it. Editing a shipped environment that still matches its
default warns first, because from then on it no longer follows the shipped
version. `main` cannot be deleted. On Android, Settings shows Environments as a
desktop-only entry.

## Environments vs profiles

Two entities decide how a session runs, and they change independently.

A **profile** is model routing: backend, model, mode, thinking level, extra
environment, and the fallback chain. An **execution environment** (above)
decides everything else about the session: its prompt, tools, plugins, MCP
surface, and ambient context.

`!profile <name>` changes the model and leaves the environment alone; `!agent
<name>` changes the environment and leaves the model alone. An environment that
pins `"profile": "__active__"` runs on whatever its conversation currently
resolves to; one that names a profile runs on that profile, as an override along
the run path. It never rewrites the conversation's own profile, so a later
`!agent reset` leaves the model exactly where it was.

### Choosing an environment per conversation

The environment is chosen the way the profile is: per conversation, over a
host-wide default.

| Command | What it does |
|---|---|
| `!agent` | Shows this conversation's environment, the host-wide default it falls back to, and the list to pick from — as buttons on Slack and Feishu |
| `!agent <name>` | Runs THIS conversation in `<name>`, from its next turn |
| `!agent reset` | Hands this conversation back to the host-wide default. `clear`, `off`, `none` and `disable` say the same thing |
| `!agent global <name>` | Sets the host-wide default: what every conversation that has not chosen one runs |
| `!agent global off` | Clears the host-wide default, leaving `main` |

Every bare form is scoped to the conversation it is typed in; the host-wide
default moves only behind the explicit `global` prefix.

In the Web app and the desktop client the same choice is the composer's own
control: a chip of its own, immediately left of the engine chip — where the turn
runs, before what runs it. It names the environment the conversation is in, or,
when the conversation has picked none, the host-wide default it falls back to,
drawn muted so a choice reads differently from a fallback. Clicking it opens one
flat list: a `default` row meaning "follow the host-wide default", then every
environment this host declares, each with what it is for and the profile it
pins. A host declaring a single environment shows no chip — there is nothing to
choose between. A pick on a new conversation travels with its first message; on
a live one it applies at once and takes effect on the next turn.

A turn resolves its environment through this chain: the session's own choice,
then the conversation's, then the host-wide default, then `main`. A name that no
longer resolves, because the environment was renamed or deleted, is skipped.

Switching obeys the same rule `!profile` does — a conversation with history may
not change backend, so an environment pinning a profile on the other backend is
refused and says which backend it would have needed. A conversation with no
turns yet may take any environment. Within one backend the switch lands on the next
turn and the history stays, which means the model sees turns it produced in the
previous environment; `!new` if that is not what you want.

### A minimal surface

The shipped `creative` environment is the smallest one Cortex ships — writing,
image prompts, naming and copy, with the operational context stripped out:

```json
{
  "name": "creative",
  "profile": "__active__",
  "systemPrompt": "file:creative.md",
  "tools": "Read,Write,Edit",
  "pluginDirs": [],
  "skills": false,
  "settingSources": [],
  "mcpComposition": "direct",
  "mcpToolAllowlist": ["send_file", "send_view", "cortex_ask_user"],
  "loadRules": false,
  "disableHooks": true,
  "projectContext": false
}
```

Three built-in tools, no Cortex plugins, no ambient rules, no hooks, no project
block, and an MCP surface of exactly three tools: `send_file` and `send_view` to
deliver, `cortex_ask_user` to ask. A session opened under it reports three tools
and zero skills when asked what it can see.

`mcpToolAllowlist` is an upper bound, not a requirement. It narrows a session's
MCP surface to the names it lists; a name the session does not compose on the
surface it opened on is simply absent there. One list therefore runs everywhere:
this `creative` keeps all three tools in the Web and desktop app, and only
`cortex_ask_user` on Slack and Feishu (their file delivery is a tool of its own,
which this list does not name). A name that exists in no bundle on the host is
still refused at spawn — that is a typo, not a surface.

### Skills outside `pluginDirs`

`pluginDirs` is not the whole skill layer. Claude Code loads its own on every
spawn no matter what Cortex passes: the plugins enabled in
`~/.claude/settings.json`, anything under `~/.claude/skills/`, and the CLI's
built-in skills. Two environment fields reach them. `settingSources: []` stops the
setting files being read at all, which removes the enabled plugins' skills;
`skills: false` removes the layer outright, built-ins included, and takes the
`Skill` tool with it. An environment that sets both sees no skills and no slash
commands.

## config/settings.json

Located at `$CORTEX_HOME/config/settings.json`. This file holds the **runtime
behavior settings** of the server: switches and limits that used to be
environment variables and needed a daemon restart to change. Editing this file
takes effect without a restart.

It is a flat JSON object that stores **only the keys you explicitly override**.
Any key you leave out falls back to its legacy environment variable when one
exists, and then to the built-in default. The file itself is optional — a fresh install has none and
runs entirely on defaults. It is created the first time something writes it: the
startup migration below, admin-channel auto-detection, or the Web workbench
settings panels.

```json
{
  "turnNotify": false,
  "turnNotifyThresholdS": 120,
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
| `notifyCompaction` | boolean | `true` | Post a chat notice when an agent's context is compacted. Covers the Claude Code (print mode) and pi backends | `CORTEX_NOTIFY_COMPACTION` |
| `showToolCalls` | boolean | `false` | Inline tool-call rendering in VirtualMessage tails | `CORTEX_SHOW_TOOL_CALLS` |
| `statusNewqButton` | boolean | `false` | Show the "New (quiet)" button on status messages (`=!newq`, which skips the pre-close hook) | `CORTEX_STATUS_NEWQ_BUTTON` |
| `autoResume` | boolean | `true` | When a usage-limit window resets, automatically continue the conversations the limit interrupted, injecting a note to pick up where they left off. Set to `false` to leave interrupted work paused for manual continuation | `CORTEX_AUTO_RESUME` |
| `providerRateLimits` | object | `{}` | Per-provider, per-quota-window throttle policy. Provider entries contain a `windows` array of `{ type, label?, enabled, threshold? }`; `threshold` is a ratio greater than `0` and at most `1` | — |
| `streamDeltas` | boolean | `true` | Stream assistant text token by token. Disable to deliver each assistant message in one piece | `CORTEX_STREAM_DELTAS` |
| `bgContinuation` | boolean | `true` | Forward the output of background tasks back into the conversation when they finish | `CORTEX_BG_CONTINUATION` |
| `eventLog` | boolean | `true` | Write the event bus to the daily rolling JSONL event log | `CORTEX_EVENT_LOG` |
| `diskMonitor` | boolean | `true` | Check free space on the filesystem containing `$CORTEX_HOME` every five minutes and send a system notice below 500 MiB. `false` stops the timer; switching back to `true` runs an immediate check | `CORTEX_DISK_MONITOR` |
| `disableUserContext` | boolean | `false` | Set to `true` to stop injecting `USER.md` context into direct conversation turns (injected by default) | `CORTEX_DISABLE_USER_CONTEXT` |
| `serverUpdateDisable` | boolean | `false` | Set to `true` to disable the server auto-update check (enabled by default) | `CORTEX_SERVER_UPDATE_DISABLE` |
| `commissionEnabled` | boolean | `true` | Kill switch for commission mode — contract-anchored long tasks. On by default: any session can enter the mode mid-conversation, either because the agent calls `cortex_commission_start` or because you flip the composer's commission capsule. Turn it off to refuse every entry point (create, composer, the start webhook) and stop injecting contract blocks; existing commissions stay readable on the board | `CORTEX_COMMISSION_ENABLED` |
| `teamEnabled` | boolean | `false` | Experimental team mode: any web session can start and manage persistent worker sessions with the `worker_*` tools. Turning it off removes those tools from the next turn and leaves existing workers as ordinary sessions. See [team.md](./team.md) | `CORTEX_TEAM_ENABLED` |
| `waitpointSweepMs` | number | `30000` | Interval, in milliseconds, of the waitpoint sweep: it drains spooled signals (locally and from connected devices), expires overdue waitpoints, and retries deliveries that failed. See [waitpoints.md](./waitpoints.md) | `CORTEX_WAITPOINT_SWEEP_MS` |
| `waitpointTtlMs` | number | `604800000` | Default lifetime of a waitpoint (7 days) when the agent does not set one. A waitpoint may ask for less, or for more up to a hard ceiling of 30 days; past it the waitpoint expires and the session is told nothing arrived | `CORTEX_WAITPOINT_TTL_MS` |
| `waitpointMaxWakesPerHour` | number | `12` | Cap on how many times a single waitpoint may wake its session per hour. A runaway signalling loop is throttled (and says so once) rather than flooding the conversation | `CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR` |
| `injectWaitMaxS` | number | `600` | Upper bound, in seconds, on how long an injected mid-turn message waits for a reply before the busy gate is released. Prevents a wedged process from holding the daemon restart gate forever | `CORTEX_INJECT_WAIT_MAX_S` |
| `memoryIndexRegenEnabled` | boolean | `true` | Run the built-in experiment/knowledge/pattern index rebuild. Switching from `false` to `true` runs it immediately | — |
| `memoryIndexRegenIntervalMs` | number | `86400000` | Interval between memory-index rebuilds, in integer milliseconds | — |
| `sessionRetentionDays` | number | `30` | Whole safe-integer retention window in days (valid range `1` through `104249991`). The retention coordinator starts a sweep in the background at daemon startup (boot does not wait for it), runs every 6 hours, and runs again after a hot-reload change; it prunes expired session-registry entries, orphan `conversation-history`, orphan PI transcript bundles, orphan Claude capture logs, orphan tool-image directories, and syncs Claude user `cleanupPeriodDays`, while skipping active sessions/captures | — |
| `piCompactReserveTokens` | number | `16384` | PI backend only: the context headroom PI keeps in reserve, in tokens. PI compacts once the context passes `contextWindow - reserveTokens` — both between turns and, since PI 0.84.4, *inside* a running turn at a tool-batch boundary — so a larger reserve compacts earlier and leaves more working room in a long tool-driven turn. A whole number from `1024` through `131072`. Cortex mirrors it into the private PI agent dir's `settings.json`, which is the only way in: PI exposes no setter for it | `CORTEX_PI_COMPACT_RESERVE_TOKENS` |
| `maxContextTokens` | number \| null | `null` | Cap on every model's usable context window, in tokens, for both backends: the usable window is the smaller of the model's own window and this value, and each backend compacts before reaching it. A whole number from `100000` through `1000000` (Claude Code's own accepted range), or `null` to leave every model at its own window. Claude receives it as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which outranks any `autoCompactWindow` in Claude's settings files; PI compacts at `cap - piCompactReserveTokens` once a model's window exceeds the cap. Context-usage percentages use the capped window | — |
| `uiCorsOrigins` | string[] | `[]` | Origins that receive CORS headers from the Web UI HTTP host. See [desktop-app.md](./desktop-app.md) | `CORTEX_UI_CORS_ORIGINS` (comma-separated) |
| `adminChannel` | string \| null | `null` | Slack channel for system notices (startup, rate-limit, disk alerts). The first DM to the bot is auto-detected and persisted here | `SLACK_ADMIN_CHANNEL`, then `CORTEX_ADMIN_CHANNEL` |
| `feishuAdminChannel` | string \| null | `null` | Feishu admin `chat_id` (`oc_...`) for the same notices. Independent of `adminChannel` — Slack channel ids are not usable on Feishu | `FEISHU_ADMIN_CHANNEL` |

The Web workbench writes a subset of these from **Settings → Notifications**
(`turnNotify`, `autoResume`, `notifyCompaction`), **Settings → Advanced**
(`eventLog`, `diskMonitor`, `showToolCalls`, `disableUserContext`,
`serverUpdateDisable`, `commissionEnabled`, `teamEnabled`, `sessionRetentionDays`,
`maxContextTokens`, `piCompactReserveTokens`, and the
built-in job switches and intervals), and the desktop/mobile **Usage** screens (`providerRateLimits`).
Every other key is edited by hand in the file.

`providerRateLimits` is a `settings.json` object keyed by provider id. Each
provider entry can contain a `windows` array whose entries are
`{ type, label?, enabled, threshold? }`. The identity of an ordinary quota row
is its provider-reported `type`; a model-scoped row uses both `type` and its
exact provider-reported `label`. An exact window entry takes precedence over
older provider-level `enabled`/`threshold` fields. Those root fields remain a
backward-compatible fallback and, when non-default, appear in Usage with an
action to clear them.

Desktop and mobile Usage place separate controls on every displayed 5-hour,
weekly, weekly-overage, Codex primary/secondary, and labeled model row. Leaving
`threshold` out uses the row default: `0.95` for `seven_day` and
`seven_day_overage_included`, `0.90` for other rows. Spend-only cards have no
quota controls. Model policy identity follows the reported display label; if a
provider renames that label, the old entry no longer matches. Policy edits
apply only to future quota observations; an already-active quota or outage
window keeps its current state until its reset time or a manual **Resume now**
clear.

Built-in job intervals must be integer milliseconds from `1000` through
`2147483647`, the safe range for Node timers. Enabled jobs run once at daemon
startup. Memory-index runs never overlap; a changed interval takes effect
after an active run finishes.

`sessionRetentionDays` is the one numeric retention control in **Settings →
Advanced**. The desktop Web UI writes it through the same
`config.set { section: 'settings' }` path as the boolean runtime toggles, and
the client enforces the same upper bound the server validates.
`piCompactReserveTokens` sits in the same card and takes the same path; the
client accepts `1024`–`131072`, exactly what the server validates. Cortex writes
it into PI's private `settings.json` when a PI session is created, so a new value
reaches the next PI session without a restart — sessions already pooled keep the
reserve they were built with.

`maxContextTokens` sits in the same card. Its field accepts `100000`–`1000000`;
clearing the field saves `null`, which leaves every model at its own window. PI
reads the cap each time it decides whether to compact, so running PI sessions
follow a new value at once. Claude takes it when its CLI process starts, so it
reaches the next Claude session; a pinned CLI compatibility trial never
receives it.

The retention coordinator has six housekeeping surfaces on that clock: live
session-registry expiry (via `delete-intent` then `delete-commit`), orphan
`data/conversation-history/*.jsonl`, orphan PI transcript bundles under
`logs/sessions-pi/`, orphan Claude capture files under `logs/sessions/`, orphan
per-session image directories under `tmp/tool-images/`, and the synced Claude
user `cleanupPeriodDays` helper. An image directory goes once its session is
neither live nor pending deletion and nothing in it changed inside the
retention window. Orphan history and PI files
use a two-sweep confirmation before deletion. Active direct sessions, running
executions, pending interaction/bg-held sessions, live PI
backend session ids, and active Claude capture pairs are protected.

Registry expiry writes the delete intents for every expired session in one
journal append, then cleans up and commits them in batches of 100 sessions;
each batch costs three registry appends however many sessions it holds. A
daemon shutdown stops a running sweep between batches. Sessions whose deletion
was not committed stay pending, and the next sweep finishes them first.

### Hot reload

The config directory is watched. A change to `settings.json` is debounced for
300 ms, the file is re-read, and the new values are used from then on — **no
daemon restart**. Two consequences worth knowing:

- Each setting takes effect at its own point of use: the next turn, the next
  agent spawn, the next built-in job run, or the next HTTP request. `uiCorsOrigins`
  is resolved per request; `adminChannel` and `feishuAdminChannel` are pushed
  into the running platform adapter as soon as they change. `diskMonitor=false`
  stops its timer, while restoring `true` starts the timer and checks immediately.
  Each built-in job switch likewise cancels or starts its timer immediately, and
  interval edits reschedule its next idle run.
- A broken file never takes the server down. Invalid JSON or a type mismatch
  leaves the previous settings in place and logs the error; fix the file and the
  next write reloads it.

### Legacy environment variables and deprecation

Keys with a legacy environment variable in the table keep it as a fallback,
parsed with its established semantics — `CORTEX_EVENT_LOG=off`, `CORTEX_TURN_NOTIFY=0`/`false`/`off`/`no`,
`CORTEX_NOTIFY_COMPACTION=0`/`false`/`off`/`no`, comma-separated lists for the two `string[]` keys,
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
  `ANTHROPIC_API_KEY`, `CORTEX_CLIENT_TOKEN`. They are
  settings in a loose sense, but keeping them out of a file that the Web UI can
  read and write keeps the blast radius small.
- **Variables consumed by child processes** — `CORTEX_HOME`,
  `CORTEX_PROJECTS_DIR`, `WEBHOOK_PORT`, `DEBUG`, `CORTEX_LANG`, and the data
  file overrides. Hooks, MCP servers, the CLI, and `cortex-client` inherit the
  daemon's environment; a server-side JSON file would never reach them.
- **Startup topology** — `CORTEX_PLATFORM`, `CORTEX_MACHINE`, `CORTEX_UI_HTTP`,
  `CORTEX_UI_PORT`, `CORTEX_UI_SPA_DIR`, `CORTEX_UI_TOKEN_LOGIN`. These decide
  which adapters and listeners exist at boot, so hot-reloading them would have
  no meaning; they require a restart by construction.

### Not the same file as .claude/settings.json

`$CORTEX_HOME/config/settings.json` (this file) configures the **Cortex
server**. `$CORTEX_HOME/.claude/settings.json` configures **Claude Code**'s
hooks and permissions and is read by the Claude CLI, not by Cortex. Same file
name, different directory, different owner, different schema — see the next
section.

## .claude/settings.json (Claude Code)

Located at `$CORTEX_HOME/.claude/settings.json`. This is the
Cortex-scaffolded Claude Code project settings file under the Cortex data root.
`cortex init` seeds it from `defaults/.claude/settings.json` once and Cortex
never overwrites that path on later runs.

Claude Code itself can also read higher-precedence project files in the spawn
cwd (`.claude/settings.local.json`, then `.claude/settings.json`) and the user
settings file at `$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`.
Cortex does not scaffold, sync, or overwrite those project-local cwd files at
all; "never overwrite" here applies only to the `$CORTEX_HOME/.claude/settings.json`
seed path above.

The session-retention coordinator has one separate Claude housekeeping write:
it merges `cleanupPeriodDays` into the user settings file
(`$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`) with a
guarded read-merge-temp-sync-rename flow. That helper owns exactly one key,
preserves every other Claude setting verbatim, and does not rewrite
hook/permission ownership or any project-local `.claude` files.

The file follows Claude Code's settings format with `hooks` and
`permissions` sections. See [hooks.md](./hooks.md) for the hook
system documentation. It has nothing to do with the Cortex runtime
settings in [`config/settings.json`](#configsettingsjson).

## defaults/config/ layout

The `agent-server/defaults/` directory in the npm package contains
shipped defaults. Most are copied to `$CORTEX_HOME/` during init; the hook
assets and the execution environments are additionally re-synced by the
server on every startup:

| Source | Destination | Overwrite behavior |
|---|---|---|
| `defaults/AGENTS.md` | `$CORTEX_HOME/AGENTS.md` | Never |
| `defaults/gitignore` | `$CORTEX_HOME/.gitignore` | Never |
| `defaults/.claude/settings.json` | `$CORTEX_HOME/.claude/settings.json` | Never — this applies only to the `$CORTEX_HOME/.claude/settings.json` scaffolded path; arbitrary repository-local `.claude/settings.json` files are outside Cortex's copy/sync loop |
| `defaults/config/budget.json` | `$CORTEX_HOME/config/budget.json` | Only with `--force` |
| `defaults/config/environments/` | `$CORTEX_HOME/config/environments/` | Per-file copy-if-missing, at init and again at every server start: a shipped environment you do not have yet is added; a file you already have is never overwritten — `--force` does not apply to this tree |
| `defaults/config/hooks/` | `$CORTEX_HOME/config/hooks/` | Per-file CalVer sync at every server start: added when missing, refreshed when the shipped `version` is newer. A declaration with no `version` — yours — is never overwritten |
| `defaults/prompts/` | `$CORTEX_HOME/prompts/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/plugins/` | `$CORTEX_HOME/plugins/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/rules/` | `$CORTEX_HOME/rules/` | Per-file: new files always added, existing preserved unless `--force` |
| `defaults/hooks/` | `$CORTEX_HOME/hooks/` | Per-file at init: never overwrite unless `--force`. At every server start, a shipped script is re-copied unless the deployed file already carries an equal or newer `@cortex-hook-version` |
| `defaults/data/schedules.json` | `$CORTEX_HOME/data/schedules.json` | Never (unless `--force`) |
| `defaults/context/` | `$CORTEX_HOME/context/` | Scaffold files: never overwrite |

This design means npm package upgrades automatically deliver new prompts,
plugins, rules, hooks, and execution environments without overwriting user
customizations. Whole-file config such as `budget.json` still requires
`--force` to replace; `config/environments/` is merged per file instead,
so newly shipped environments reach existing installs without touching your edits.

## Hot-reload behavior

Watcher-backed files under `config/` automatically switch to filesystem
snapshot polling every 5 seconds if the watcher cannot start or reports a
runtime error. Each loader keeps the same validation and failure behavior in
polling mode as it uses with filesystem events.

- **`config/settings.json`** — watched via file watcher, debounced 300 ms. New
  values apply at the next point of use without a restart; a broken file keeps
  the previous settings. See [config/settings.json](#configsettingsjson).
- **`schedules.json`** — watched via file watcher. Changes are picked up
  within seconds without restart. See [scheduling.md](./scheduling.md)
  for the full scheduling system.
- **`profiles.json`** — cached and watched for parseable JSON changes. An
  update refreshes the cache before the next agent spawn; malformed JSON keeps
  the previous profiles.
- **`machines.json`** — watched and reloaded after valid changes. Invalid
  entries keep the previous machine registry.
- **`environments/`** — watched. Changes are debounced (300 ms) and every
  environment is reloaded without a restart. See
  [Execution environments](#execution-environments).
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
| `environments/` | Execution environments — one JSON per environment | `$CORTEX_HOME/config/environments/` |
| `machines.json` | Machine registry | `$CORTEX_HOME/config/machines.json` |
| `budget.json` | Budget limits | `$CORTEX_HOME/config/budget.json` |
| `mcp-config.json` | MCP server config | `$CORTEX_HOME/config/mcp-config.json` |
| `.claude/settings.json` | Claude Code hooks/permissions (not the Cortex settings file) | `$CORTEX_HOME/.claude/settings.json` |
| `mode.json` | Runtime mode | `$CORTEX_HOME/data/mode.json` |
| `schedules.json` | Schedules | `$CORTEX_HOME/data/schedules.json` |
| `session-registry.jsonl` | Append-only session registry journal | `$CORTEX_HOME/data/session-registry.jsonl` |
| `retention-candidates.json` | Two-sweep orphan cleanup candidates | `$CORTEX_HOME/data/retention-candidates.json` |
| `conversation-history/` | Per-session transcript/history JSONL | `$CORTEX_HOME/data/conversation-history/` |
| `logs/sessions/` | Claude capture logs | `$CORTEX_HOME/logs/sessions/` |
| `logs/sessions-pi/` | PI transcript bundles | `$CORTEX_HOME/logs/sessions-pi/` |
| `hooks/*.json` | Hook declarations | `$CORTEX_HOME/config/hooks/` |
