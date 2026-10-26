# Configuration

Cortex reads configuration from `$CORTEX_HOME/config/`. Messaging integrations
are optional: browser and app sessions can run without a Slack or Feishu bot.
Each enabled messaging platform needs its own credentials.

## File hierarchy

All paths below are relative to `$CORTEX_HOME` (default: `~/.cortex/`).

```
$CORTEX_HOME/
├── AGENTS.md                     # Root instructions for agent sessions (scaffolded once)
├── config/
│   ├── .env                      # Secrets, platform credentials, startup variables
│   ├── settings.json             # Runtime behavior settings (hot-reloaded)
│   ├── preferences.json          # UI language for system messages (`!lang`)
│   ├── models.json             # Default engine and favorite models
│   ├── environments/             # Execution environments — one JSON per environment
│   ├── machines.json             # Machine registry for remote clients
│   ├── budget.json               # Daily/monthly budget limits
│   ├── mcp-config*.json          # Generated MCP configurations, rewritten at every start
│   ├── board.css                 # Optional stylesheet for every board (absent by default)
│   ├── agents/                   # Your subagent roles and overrides of the built-in ones
│   ├── archive/                  # Configuration an upgrade retired, moved aside
│   └── hooks/                    # Your hook declarations and overrides of the built-in ones
├── data/
│   ├── agent-state.json          # Channel selections, model memory, new-session choice, default agent
│   ├── schedules.json            # Persistent schedule list
│   ├── boards.json               # Board registry
│   ├── executions.json           # Unified execution registry
│   ├── costs.jsonl               # 90-day rolling cost records
│   ├── provider-state.json       # Provider usage, throttle windows, resume queue
│   ├── waitpoints.json           # Armed and resolved waitpoints
│   ├── session-registry.jsonl    # Session records, channel bindings, conversation headers + turns (single owner)
│   ├── retention-candidates.json # Two-sweep orphan retention markers
│   ├── ui-sessions.json          # Browser login sessions for the Web UI
│   ├── conversation-history/     # Per-session transcript/history JSONL
│   ├── archive/                  # Terminal execution records older than a week
│   ├── claude/                   # Cortex's own Claude Code config dir (CLAUDE_CONFIG_DIR)
│   └── pi/                       # Cortex's PI agent dir
├── .claude/
│   └── settings.json             # Cortex-scaffolded Claude Code project settings
├── hooks/                        # Your hook scripts (.mjs)
├── plugins/                      # Your plugins, and your layers of the built-in ones
├── prompts/                      # Your system prompts, directives, templates
├── rules/                        # Your context rules for agent sessions
├── context/                      # Dense Context knowledge repository
│   └── projects/                 # Research project files
├── logs/                         # Daemon and backend session logs
│   ├── events/                   # Daily event-bus JSONL (the `eventLog` setting)
│   ├── sessions/                 # Claude capture logs
│   └── sessions-pi/              # PI transcript bundles
├── tmp/                          # Temporary workspaces, spooled signals, tool images
└── workspaces/                   # Clean-mode workspaces, one folder per clean session or subagent
```

The gateway configuration, `~/.aistatus/gateway.yaml`, lives outside
`$CORTEX_HOME`; `cortex setup-gateway` and provider logins write it.

## Loading order and precedence

1. **Built-in defaults** (`agent-server/defaults/`) ship with the npm
   package and provide fallback values for every config file. The built-in
   plugins, hooks, rules, agent roles and system prompts are read from there
   in place, with your files in `$CORTEX_HOME` laid over them (see
   [Built-in assets and your overrides](#built-in-assets-and-your-overrides)).
2. **`$CORTEX_HOME/config/.env`** is loaded at daemon startup via
   `dotenv`. Existing launcher environment variables take precedence over the
   file, and the worker inherits the daemon environment.
3. **`$CORTEX_HOME/config/settings.json`** holds the runtime behavior
   settings. It is cached, re-read whenever the file changes, and each setting
   takes effect at its own point of use.
   For every key it defines, it overrides the legacy environment
   variable of the same setting.
4. **`$CORTEX_HOME/config/models.json`** is cached and watched for changes
   to the default engine selection and favorite models.
5. **`$CORTEX_HOME/.claude/settings.json`** is the Cortex-scaffolded
   Claude Code project settings file. Claude Code may also read
   `<spawn cwd>/.claude/settings.local.json`, `<spawn cwd>/.claude/settings.json`,
   and its user settings file, which for every Cortex-started `claude` is
   `$CORTEX_HOME/data/claude/settings.json` (see
   [Claude Code config directory](#claude-code-config-directory)). The
   terminal's `~/.claude/settings.json` is not read.

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
Every variable is optional; a platform's credentials are needed only to bring
that platform online.

Server behavior settings belong in [`config/settings.json`](#configsettingsjson),
where they hot-reload. A legacy variable for one of those settings is read as a
deprecated fallback and moved out of `.env` automatically at the next daemon
start (see [Automatic migration out of .env](#automatic-migration-out-of-env)).

### Paths

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_HOME` | `~/.cortex/` | User data root (config, context, logs, store) |
| `CORTEX_PROJECTS_DIR` | `<CORTEX_HOME>/context/projects/` | Override project directory |
| `CORTEX_AGENT_CWD` | `$CORTEX_HOME` | Working directory of every agent backend process. Must be an absolute path to an existing directory; anything else stops the server at startup |
| `CORTEX_REPO` | — | The `agent-server/` directory of a source checkout. The daemon watches its `src/` and rebuilds, reinstalls and restarts on change (see [Hot rebuild](./architecture.md#hot-rebuild-published-progress-and-the-turn-hold)); the server update check is skipped while it is set |
| `CORTEX_CLIENT_REPO` | — | A `client/` source directory that remote client bundles are built from instead of the packaged bundle |
| `CORTEX_NPM_PREFIX` | the running install's prefix | npm prefix used when Cortex installs or updates itself |

### Startup

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_MACHINE` | `os.hostname()` | Machine label for startup DM |
| `CORTEX_LANG` | `config/preferences.json`, else `en` | Language of system-generated messages (`en` or `zh`). Outranks the preference that `!lang` writes |
| `CORTEX_CLIENT_PORT` | `3002` | WebSocket port for cortex-client manager |
| `CORTEX_CLIENT_HOST` | Unspecified (all interfaces) | Bind address for the cortex-client WebSocket listener only; read at server startup |
| `CORTEX_CLIENT_TOKEN` | generated | Shared secret that remote clients present; the desktop app and the Web UI accept it as an alternative to a pairing code. `cortex init` and the first server start generate it |
| `CORTEX_WEBHOOK_TOKEN` | generated | Bearer token of the loopback webhook (hook callbacks, `cortex-hook ask`). Generated the same way |

A new Windows local App installation writes `CORTEX_CLIENT_HOST=127.0.0.1` to
`config/.env`. Existing installations, ordinary CLI init, and other platforms keep
their existing defaults and configuration. For intentional LAN-direct clients,
explicitly set this variable to an appropriate bind address (for example,
`0.0.0.0` for all IPv4 interfaces) and restart the server. Cortex does not
configure firewall policy automatically. This setting does not affect Web UI,
TUI, or other server listeners.

### Platform

`CORTEX_PLATFORM` selects the messaging platform(s). It accepts a single value
(`slack`, `feishu`) or a **comma-separated list** to run several at once
(`slack,feishu`), and defaults to `slack`. Each listed platform whose
credentials are present is brought online and the others are skipped, so a
server with no credentials at all runs without a chat platform and serves the
Web UI, desktop app and TUI only. The TUI gateway runs alongside every
platform unless `CORTEX_TUI=0`. With multiple platforms, messages route by
platform and system notices fan out to each platform's admin channel.

| Variable | Required | Purpose |
|---|---|---|
| `CORTEX_PLATFORM` | no | `slack` (default). Comma list for multi-platform, e.g. `slack,feishu` |
| `SLACK_BOT_TOKEN` | for slack | Slack Bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | for slack | Slack app signing secret |
| `SLACK_APP_TOKEN` | for slack | Slack app-level token for Socket Mode (`xapp-...`) |
| `FEISHU_APP_ID` | for feishu | Feishu app ID (`cli_...`) |
| `FEISHU_APP_SECRET` | for feishu | Feishu app secret |
| `FEISHU_ENCRYPT_KEY` | no | Feishu event encrypt key (optional with long-connection) |
| `FEISHU_VERIFICATION_TOKEN` | no | Feishu event verification token (optional) |
| `FEISHU_DOMAIN` | no | `feishu` (default) or `lark` for the international edition |
| `FEISHU_AUTH_MODE` | no | `bot` (default) or `user`. `cortex feishu login` sets `user`, so Feishu document tools act as the signed-in user |
| `FEISHU_USER_SCOPE` | no | Scopes `cortex feishu login` requests when `--scope` is not given |
| `FEISHU_REDIRECT_URI` | no | Redirect URI for `cortex feishu login --manual` |

The admin channels for system notices are settings, not environment variables:
see `adminChannel` and `feishuAdminChannel` in
[`config/settings.json`](#configsettingsjson). The legacy variables
`SLACK_ADMIN_CHANNEL`, `CORTEX_ADMIN_CHANNEL`, and `FEISHU_ADMIN_CHANNEL` are
still read as a deprecated fallback.

### API

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key used by Claude Code runs on a metered (`api`) route |
| `ANTHROPIC_BASE_URL` | Anthropic endpoint for Claude Code runs while the local gateway is down. With the gateway healthy, each run's base URL is its gateway route instead |

### Web UI and TUI

The Web UI host serves the browser workbench, the desktop app and the mobile
app. [Browser access](./browser-access.md) covers token login, pairing codes and
Cloudflare Access in depth.

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_UI_HTTP` | off | `1`, `true`, `on` or `yes` starts the Web UI host. `cortex ui enable` sets it |
| `CORTEX_UI_PORT` | `3004` | Port of the Web UI host, bound to `127.0.0.1` |
| `CORTEX_UI_SPA_DIR` | the packaged `web/dist` | Directory of the web app the host serves |
| `CORTEX_UI_TOKEN_LOGIN` | on | Browser login with the client token or a pairing code, and app pairing with one-time codes. `0`, `false`, `off` or `no` removes the login and pairing routes; already-paired apps keep working |
| `CORTEX_UI_SESSION_TTL_DAYS` | `30` | Lifetime of a browser login session, in days |
| `CORTEX_ACCESS_TEAM_DOMAIN`, `CORTEX_ACCESS_AUD`, `CORTEX_ACCESS_CERTS_URL` | — | Cloudflare Access JWT verification for browsers; both of the first two are needed to enable it |
| `CORTEX_PORT_FORWARD` | on | `0` disables the Web UI's port forwarding to remote machines |
| `CORTEX_TUI` | on | `0` stops the TUI gateway |
| `CORTEX_TUI_PORT` | `3003` | Port of the TUI gateway, also the one `cortex tui` connects to |

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
| `WEBHOOK_PORT` | `3001` | Port of the loopback webhook server that receives hook, waitpoint, subagent and board callbacks |

### Data file overrides

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_EXECUTIONS_FILE` | `<STORE_DIR>/executions.json` | Execution records |
| `CORTEX_COSTS_FILE` | `<STORE_DIR>/costs.jsonl` | Cost tracking |
| `CORTEX_BUDGET_FILE` | `<CONFIG_DIR>/budget.json` | Budget configuration |
| `CORTEX_SESSION_TOTALS_FILE` | `<STORE_DIR>/session-totals.json` | Per-session cost and token totals carried over from archived executions |

`<STORE_DIR>` is `$CORTEX_HOME/data` and `<CONFIG_DIR>` is `$CORTEX_HOME/config`.

### Telemetry

| Variable | Default | Purpose |
|---|---|---|
| `CORTEX_TELEMETRY` | — | `0` turns anonymous telemetry off whatever `telemetryEnabled` says. `1` lets a source checkout send it, marked `dev`. See [Telemetry](./telemetry.md) |
| `DO_NOT_TRACK` | — | Any value other than empty, `0`, `false`, `no` or `off` turns telemetry off, like `CORTEX_TELEMETRY=0` |

### Tuning and debugging

| Variable | Default | Purpose |
|---|---|---|
| `DEBUG` | — | Enable server-wide debug mode. In addition to debug-level logs, the desktop transcript shows hover inspectors for the exact agent message and each tool call's complete input/result. Only `DEBUG=1` enables it; all other values disable it. **Settings → Advanced → Diagnostics** shows whether it is on; restart agent-server after changing it |
| `CORTEX_DEBUG_TOOL_WARNING_CHARS` | `10000` | In DEBUG transcripts, mark a tool-name badge amber when its formatted complete parameters plus complete result strictly exceed this Unicode character count. Positive integers only; invalid values use the default. Restart agent-server after changing it |
| `CORTEX_BG_GRACE_S` | `90` | Seconds a run waits for a background task the backend reported finished but never announced (see [How backends work](./backends.md#how-backends-work)) |
| `CORTEX_BG_WAIT_MAX_S` | `1800` | Seconds a turn waits on still-running background work before it stops waiting; the work itself continues |
| `CORTEX_STREAM_DELTA_MS` | `120` | Flush interval, in milliseconds, for streamed assistant text |
| `CORTEX_AGENT_BROWSER_BIN` | the bundled binary | agent-browser binary that `cortex-browser` runs (see [Agent Browser](./agent-browser.md)). A path that does not exist is an error |
| `CORTEX_BROWSER_BINARY` | auto-detected | Chrome or Chromium binary for the server's agent browser |
| `CORTEX_BROWSER_DISPLAY` | auto-detected | X display the server's agent browser uses, skipping display detection |
| `CORTEX_GPU_MONITOR_MOCK` | — | Mock GPU data JSON for testing (overrides real nvidia-smi queries) |

The event log, tool-call rendering, user-context injection, update check,
compaction notice, turn notification, and auto-resume switches are settings
keys — see [`config/settings.json`](#configsettingsjson).

`DEBUG` persists unabridged prompts, tool parameters, and tool results in per-session conversation-history files. These values can contain secrets, private file contents, or large outputs, and storage grows with their full size. Enable this mode only on a trusted development server and turn it off when inspection is complete. Turning it off immediately removes debug fields and buttons from transcript responses, but it does not delete records captured earlier.

## models.json

Located at `$CORTEX_HOME/config/models.json`. It stores the default engine
selection and a list of favorite models. **Settings → Models** manages the
default and favorites; the composer's full model list also lets you star or
unstar models. For backend details, see [backends.md](./backends.md).

### Schema

```json
{
  "default": {
    "backend": "claude",
    "provider": null,
    "model": "opus",
    "thinking": "high",
    "mode": "plan"
  },
  "favorites": [
    { "backend": "claude", "provider": null, "model": "opus" },
    { "backend": "pi", "provider": "deepseek", "model": "deepseek-v4-pro" }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `default` | object | yes | Complete engine selection used when a session or channel has none |
| `default.backend` | string | yes | `claude` or `pi` |
| `default.provider` | string or null | yes | `null` for Claude; an explicit provider id for PI, such as `openai-codex`, `deepseek`, or a [custom provider](./backends.md#custom-providers) |
| `default.model` | string | yes | Non-empty model identifier, as the backend names it |
| `default.thinking` | string or null | yes | Backend-native reasoning level; `null` uses the backend's default |
| `default.mode` | string | yes | Gateway route, such as `plan` or `api` for Claude; PI uses its provider name |
| `favorites` | object[] | yes | Ordered model references, each with `backend`, `provider`, and `model`. Each model identity occurs at most once |

Favorites store model identities, not thinking levels or routes. The default
need not be a favorite, and the favorites list may be empty. `thinking` accepts
`low`/`medium`/`high`/`xhigh`/`max` on Claude and
`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max` on PI.

### Selection resolution

An ordinary turn uses the session's recorded selection, then the channel's
selection in `data/agent-state.json`, then `models.json`'s `default`. An explicit
run request, such as a scheduled fire, can supply a complete selection directly.
Each selection contains `backend`, `provider`, `model`, `thinking`, and `mode`;
execution environments are independent of this choice.

`data/agent-state.json` stores `channelSelections`, per-model `modelMemory`
(`thinking` and `mode`, keyed by the JSON array `[backend, provider, model]`),
and `selectionDefault`, the last Web engine choice used to seed new conversations.
Selecting a model restores its remembered thinking and route. Without a memory,
thinking is `null`; Claude uses the first Anthropic route in `gateway.yaml`
(`plan` if none is declared), and PI uses its provider name. User selection
changes update this memory. See
[per-session controls](./backends.md#per-session-model-thinking-level-and-route).

`!backend <claude|pi>` uses the configured default when it belongs to the target
backend; otherwise it uses the first favorite on that backend, with its
remembered settings. If neither exists, favorite a model on that backend first.

### Validation rules

`mode` and PI `provider` must match `^[a-zA-Z0-9_-]+$`. Claude requires a null
provider. Thinking must be null or one of the backend's allowed values, and
favorite identities must be unique. Selection writes validate the route against
`gateway.yaml` when it is available. A file that parses but fails schema
validation is rejected as a whole until corrected.

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
| `main` | General-purpose work on the session’s selected engine, with the built-in Cortex system, board, and Feishu plugins. It is the default: a session that has not picked an environment runs in `main`, and `main` cannot be deleted |
| `creative` | A clean-room surface for writing, image prompts, naming, and copy, with the operational context stripped out (see [A minimal surface](#a-minimal-surface)) |

The shipped files are copied into `config/environments/` at `cortex init`, and
again at every server start when they are missing (a sealed home, with
`CORTEX_CONFIG_IMMUTABLE=1`, skips that start-time copy). A file you already have is
never overwritten, so your edits survive upgrades, and a file you add is an
environment like any other. Changes to the directory are picked up about 300 ms
later without a restart. A file that is not valid JSON, or whose `name` does not
match its file name, is skipped and logged.

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | Must equal the file name without `.json` |
| `description` | string | no | One line describing what the environment is for, shown in pickers |
| `directive` | string | no | Role or identity text prepended to the prompt |
| `systemPrompt` | string | no | Replaces the backend's default system prompt |
| `promptTemplate` | string | no | Wraps each message; `{{input}}` stands for what was sent |
| `claudeAgent` | string | no | Claude Code agent name, passed as `--agent`. Claude only |
| `outputStyle` | string | no | Claude Code output style. Claude only |
| `tools` | string | no | Comma-separated built-in tool list that replaces the backend's default set |
| `pluginDirs` | string[] | no | Plugin directories to load, relative to `$CORTEX_HOME` unless absolute. They load first, in the order listed, followed by the built-in plugins |
| `disabledPlugins` | string[] | no | Built-in plugin ids this environment leaves out. Every other built-in plugin loads, unless `skills` is `false`, in which case only `pluginDirs` loads |
| `mcpComposition` | `"direct"` \| `"none"` | no | `direct` (default) gives the session the Cortex MCP tools; `none` gives it no MCP at all, plugin servers included |
| `mcpToolAllowlist` | string[] | no | Narrows the Cortex MCP tools to the names listed. Absent keeps the full surface |
| `loadRules` | boolean | no | Default `true`: prepend the global rules from `rules/` |
| `disableHooks` | boolean | no | Default `false`. `true` runs the session without lifecycle hooks |
| `skills` | boolean | no | Default `true`. `false` removes the backend's skill layer, including the `Skill` tool |
| `settingSources` | string[] | no | Which Claude setting files to read: any of `user`, `project`, `local`. Absent uses the CLI default; `[]` reads none |
| `projectContext` | boolean | no | Default `true`: tell the session which project it belongs to on its first turn |

The three prompt fields accept `file:<name>` instead of literal text. The text is
then read from `prompts/directives/`, `prompts/systemPrompts/`, or
`prompts/promptTemplates/` respectively, and from the built-in prompt of that
name when `$CORTEX_HOME` has none; the shipped `main` uses
`"systemPrompt": "file:direct.md"`. A field the schema does not know, a missing
prompt file, or a missing plugin directory is reported as a warning, and the
environment still loads.

### Plugins and the Environments panel

Plugins attach to environments. An environment's sessions load the plugins its
`pluginDirs` lists and every built-in plugin its `disabledPlugins` does not
name; the environment's Plugins tab writes those same fields, and **Settings → Plugins** shows which environments use
each installed plugin (see
[Skills and Plugins](./skills-and-plugins.md#assigning-plugins)).

In the Web workbench and the desktop app, **Settings → Environments** lists
every environment and edits one at a time: the JSON body with live validation,
a Validation tab for errors and warnings, and a Plugins tab for its plugin set.
A new environment starts from a skeleton that already validates, and an existing
one can be duplicated under a new name. Errors block a save, warnings do not,
and a save made against a file that changed on disk in the meantime is refused
rather than overwriting it. Editing a shipped environment that still matches its
default warns first, because from then on it stops following the shipped
version. `main` cannot be deleted. On Android, Settings shows Environments as a
desktop-only entry.

The System prompt tab edits the text an environment's `systemPrompt` resolves
to, which replaces the backend's default system prompt as a whole. When the
field is a `file:` reference, the tab edits that file under
`prompts/systemPrompts/` and names any other environment that references the
same file, since a save changes the prompt for all of them. When the field is
literal text or absent, saving writes the text to
`prompts/systemPrompts/<name>.md` and points the environment at it. Empty text
leaves the environment on the backend's default prompt. A prompt file that
ships with Cortex shows its built-in text until you save your own version, which
is written to `prompts/systemPrompts/` and used in its place; **Restore default**
loads the built-in text into the editor, and saving it removes your version.
New sessions start with the saved prompt. A session already open on the PI
backend switches to it on its next turn; one on Claude Code keeps its prompt
until its backend process restarts.

## Environments and engine selection

The engine selection decides backend, provider, model, thinking, and mode. An
**execution environment** decides the prompt, tools, plugins, MCP surface, and
ambient context. They change independently: `!model <id>` changes the model;
`!agent <name>` changes the environment. `!agent reset` also leaves the engine
selection intact.

### Choosing an environment per conversation

The environment is chosen per conversation, over a host-wide default.

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
environment this host declares, each with what it is for. A host declaring a single environment shows no chip — there is nothing to
choose between. A pick on a new conversation travels with its first message; on
a live one it applies at once and takes effect on the next turn.

A turn resolves its environment through this chain: the session's own choice,
then the conversation's, then the host-wide default, then `main`. A name that no
longer resolves, because the environment was renamed or deleted, is skipped.

Switching environments leaves the backend unchanged. It takes effect on the
next turn and preserves history, so the model sees turns from the previous
environment; use `!new` for a fresh context.

### A minimal surface

The shipped `creative` environment is the smallest one Cortex ships — writing,
image prompts, naming and copy, with the operational context stripped out:

```json
{
  "name": "creative",
  "description": "Clean-room creative environment: writing, image prompts, naming, copy. No skills, no project rules, minimal tools.",
  "promptTemplate": "{{input}}",
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

### Clean mode

A clean conversation works in a folder of its own, out of reach of what Cortex
knows: a second opinion, a reviewer that should see only what it is handed, a
task that must start from nothing.

The composer of a new conversation in the Web and desktop app, and on a phone,
has a **Clean** toggle among its chips. It is off for every new
conversation; turned on, the conversation is clean from its first message, for
its whole life. A clean conversation keeps the mark where the toggle was (in the
header on a phone), and opening it shows the workspace path to copy, or, in the
desktop app, to open.

When the conversation starts, Cortex creates its workspace,
`$CORTEX_HOME/workspaces/<id>/` — the first eight characters of the session id,
with a numeric suffix when that folder exists — and an `inputs/` folder inside
it. The workspace is the agent's working directory on every turn. A clean
session:

- loads no `AGENTS.md` or `CLAUDE.md` from the workspace or its ancestors. Claude
  runs without the `project` setting source: an environment that declares no
  `settingSources` gets `user,local`, and one that declares a list keeps it
  without `project`. PI loads no context files;
- loads no Cortex rules and runs no agent hooks;
- receives no `[Session Project]`, `[Session Transcripts]` or `[Board]` block;
- on Claude, gets no git status or git instructions in its system prompt
  (`includeGitInstructions: false`), so the repository that holds
  `$CORTEX_HOME` does not show its branch and recent commits to the agent.

Everything else its environment gives it stays: the system prompt and
directive, tools, skills, MCP tools, the user profile and the team blocks. A
**Workspace** section follows the system prompt. It tells the agent that the
workspace is the only place holding information for the task, to read and
write only there, to keep scratch files in the workspace's `tmp/`, and to say
what is missing rather than look for it elsewhere. The text ships as
`defaults/prompts/clean-workspace.md`; a `prompts/clean-workspace.md` of yours
replaces it, with `{{workspace}}` standing for the workspace's absolute path.

Files attached to a clean conversation are copied into `inputs/` under their own
names, and the agent is pointed at the copies. Clean mode keeps Cortex context
out of the session and asks the agent to stay in its folder; it does not fence
the agent in at the operating-system level. Workspaces are never deleted — the
retention sweep that removes an old session leaves its workspace in place,
since it may hold what the agent produced.

Subagents run clean the same way; see [Subagents](./backends.md#subagents).

### Skills outside `pluginDirs`

`pluginDirs` is not the whole skill layer. Claude Code loads its own on every
spawn no matter what Cortex passes: the plugins enabled in its setting files
(installed under Cortex's Claude config directory, `$CORTEX_HOME/data/claude`),
anything under `$CORTEX_HOME/data/claude/skills/`, and the CLI's built-in skills. Two environment fields reach them. `settingSources: []` stops the
setting files being read at all, which removes the enabled plugins' skills;
`skills: false` removes the layer outright, built-ins included, and takes the
`Skill` tool with it. An environment that sets both sees no skills and no slash
commands.

## config/settings.json

Located at `$CORTEX_HOME/config/settings.json`. This file holds the **runtime
behavior settings** of the server: switches, limits and notification routes.
Editing this file takes effect without a daemon restart, except for the few
keys read once at startup, which the table marks.

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

Values are checked against the schema below when the file is read. A key whose
JSON type does not match, or whose value is outside its documented range (the
job intervals, `sessionRetentionDays`, `piCompactReserveTokens`,
`maxContextTokens`, `cacheKeepWarmHours`, the shape of `providerRateLimits`), rejects the whole file:
at startup Cortex falls back to environment variables and defaults, and on a
reload it keeps the last valid settings. Either way the reason is logged.
Unknown keys are ignored.

### Keys

| Key | Type | Default | Effect | Legacy env variable |
|---|---|---|---|---|
| `turnNotify` | boolean | `true` | When a long-running turn finishes, post a fresh message to the conversation so you get a push notification (the inline status seals to "✓ Done" with an edit, which Slack and Feishu do not notify on). Both success and failure are announced | `CORTEX_TURN_NOTIFY` |
| `turnNotifyThresholdS` | number | `60` | Minimum turn duration, in seconds, before that completion notification is posted. Shorter turns stay quiet | `CORTEX_TURN_NOTIFY_THRESHOLD_S` |
| `notifyCompaction` | boolean | `true` | Post a chat notice when an agent's context is compacted. Covers the Claude Code (print mode) and pi backends | `CORTEX_NOTIFY_COMPACTION` |
| `showToolCalls` | boolean | `false` | Post a compact line for each tool call in Slack and Feishu replies, merging consecutive calls to the same tool. Also on **Settings → Platform** | `CORTEX_SHOW_TOOL_CALLS` |
| `statusNewqButton` | boolean | `false` | Show the "New (quiet)" button on status messages (`=!newq`, which skips the pre-close hook) | `CORTEX_STATUS_NEWQ_BUTTON` |
| `autoResume` | boolean | `true` | When a usage-limit window resets, automatically continue the conversations the limit interrupted, injecting a note to pick up where they left off. Set to `false` to leave interrupted work paused for manual continuation | `CORTEX_AUTO_RESUME` |
| `providerRateLimits` | object | `{}` | Per-provider, per-quota-window throttle policy. Provider entries contain a `windows` array of `{ type, label?, enabled, threshold? }`; `threshold` is a ratio greater than `0` and at most `1` | — |
| `showThinking` | boolean | `true` | Capture model-provided thinking for Web and mobile chat. Disable to stop capturing new thinking; saved rows remain visible. Claude requests a thinking summary; PI displays the text the provider returns | `CORTEX_SHOW_THINKING` |
| `streamDeltas` | boolean | `true` | Stream assistant text and captured thinking token by token. Disable to deliver only complete blocks | `CORTEX_STREAM_DELTAS` |
| `bgContinuation` | boolean | `true` | Forward the output of background tasks back into the conversation when they finish | `CORTEX_BG_CONTINUATION` |
| `eventLog` | boolean | `true` | Write the event bus to the daily rolling JSONL event log | `CORTEX_EVENT_LOG` |
| `diskMonitor` | boolean | `true` | Check free space on the filesystem containing `$CORTEX_HOME` every five minutes and send a system notice below 500 MiB. `false` stops the timer; switching back to `true` runs an immediate check | `CORTEX_DISK_MONITOR` |
| `disableUserContext` | boolean | `false` | Set to `true` to stop injecting `USER.md` context into direct conversation turns (injected by default) | `CORTEX_DISABLE_USER_CONTEXT` |
| `serverUpdateDisable` | boolean | `false` | Set to `true` to disable the server auto-update check (enabled by default) | `CORTEX_SERVER_UPDATE_DISABLE` |
| `serverAutoUpdate` | boolean | `true` | When the update check finds a newer server release, install it without asking. Installation starts only once no turn is running, and the server restarts right after. `false` asks for confirmation first; an agreed update waits for idle the same way. A skipped version stays skipped | — |
| `clientHotReloadEnabled` | boolean | `true` | Push the server's client bundle to connecting remote clients that run a different one, so they update themselves. Read at startup | — |
| `telemetryEnabled` | boolean | `true` | Send anonymous crash reports and usage statistics (see [Telemetry](./telemetry.md)). Turning it off deletes what is queued. `CORTEX_TELEMETRY=0` and `DO_NOT_TRACK` override it | — |
| `feishuSkillsInWeb` | boolean | `false` | Let `web:` sessions, including desktop and mobile app sessions, load an assigned `cortex-feishu` skill plugin (see [Platform settings in the Web UI](#platform-settings-in-the-web-ui)) | — |
| `teamEnabled` | boolean | `true` | Experimental team mode: any web session can start and manage persistent worker sessions with the `worker_*` tools. Turning it off removes those tools from the next turn and leaves existing workers as ordinary sessions. See [team.md](./team.md) | `CORTEX_TEAM_ENABLED` |
| `waitpointSweepMs` | number | `30000` | Interval, in milliseconds, of the waitpoint sweep: it drains spooled signals (locally and from connected devices), expires overdue waitpoints, and retries deliveries that failed. See [waitpoints.md](./waitpoints.md) | `CORTEX_WAITPOINT_SWEEP_MS` |
| `waitpointTtlMs` | number | `604800000` | Default lifetime of a waitpoint (7 days) when the agent does not set one. A waitpoint may ask for less, or for more up to a hard ceiling of 30 days; past it the waitpoint expires and the session is told nothing arrived | `CORTEX_WAITPOINT_TTL_MS` |
| `waitpointMaxWakesPerHour` | number | `12` | Cap on how many times a single waitpoint may wake its session per hour. A runaway signalling loop is throttled (and says so once) rather than flooding the conversation | `CORTEX_WAITPOINT_MAX_WAKES_PER_HOUR` |
| `injectWaitMaxS` | number | `600` | Upper bound, in seconds, on how long an injected mid-turn message waits for a reply before the busy gate is released. Prevents a wedged process from holding the daemon restart gate forever | `CORTEX_INJECT_WAIT_MAX_S` |
| `anthropicSubscriptionModes` | string[] | `["plan"]` | Gateway modes whose Anthropic account quota is polled for the Usage screens. `[]` turns the polling off | — |
| `subscriptionBillingModes` | string[] | `["plan", "openai-codex", "google-gemini-cli", "google-antigravity"]` | Gateway modes paid by a subscription. The gateway still prices their requests, but usage rows for these modes show quota only and no cost | — |
| `providerUsageCollectionEnabled` | boolean | `true` | Run the built-in provider-usage collection job that refreshes quota and spend readings | — |
| `providerUsageCollectionIntervalMs` | number | `300000` | Interval between provider-usage collections, in integer milliseconds | — |
| `claudeWindowWarmupEnabled` | boolean | `false` | Claude on a subscription mode (see `anthropicSubscriptionModes`) only. Claude's five-hour usage window opens with the first request after the previous window closed. With this on, once the window has closed and no Claude run has started for ten minutes, Cortex sends one tiny request (Haiku, no tools, through Claude Code on the first subscription mode's route) to open the next window, so it closes five hours later instead of five hours after work resumes. The request also lets Claude Code refresh its login, which keeps the Anthropic usage reading current. The window's close time comes from the Anthropic usage reading; a failed warm-up is retried after 30 minutes. Also on **Settings → Advanced** | — |
| `storeArchiveEnabled` | boolean | `true` | Once a day, move terminal execution records older than a week from `data/executions.json` to `data/archive/`. Read at startup | — |
| `memoryIndexRegenEnabled` | boolean | `true` | Run the built-in experiment/knowledge/pattern index rebuild. Switching from `false` to `true` runs it immediately | — |
| `memoryIndexRegenIntervalMs` | number | `86400000` | Interval between memory-index rebuilds, in integer milliseconds | — |
| `sessionRetentionDays` | number | `30` | Whole safe-integer retention window in days (valid range `1` through `104249991`). The retention coordinator starts a sweep in the background at daemon startup (boot does not wait for it), runs every 6 hours, and runs again after a hot-reload change; it prunes expired session-registry entries, orphan `conversation-history`, orphan PI transcript bundles, orphan Claude capture logs, orphan tool-image directories, and syncs Claude user `cleanupPeriodDays`, while skipping active sessions/captures | — |
| `piCompactReserveTokens` | number | `16384` | PI backend only: the context headroom PI keeps in reserve, in tokens. PI compacts once the context passes `contextWindow - reserveTokens` — both between turns and, since PI 0.84.4, *inside* a running turn at a tool-batch boundary — so a larger reserve compacts earlier and leaves more working room in a long tool-driven turn. A whole number from `1024` through `131072`. Cortex mirrors it into the private PI agent dir's `settings.json`, which is the only way in: PI exposes no setter for it | `CORTEX_PI_COMPACT_RESERVE_TOKENS` |
| `maxContextTokens` | number \| null | `null` | Cap on every model's usable context window, in tokens, for both backends: the usable window is the smaller of the model's own window and this value, and each backend compacts before reaching it. A whole number from `100000` through `1000000` (Claude Code's own accepted range), or `null` to leave every model at its own window. Claude receives it as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, which outranks any `autoCompactWindow` in Claude's settings files; PI compacts at `cap - piCompactReserveTokens` once a model's window exceeds the cap. Context-usage percentages use the capped window | — |
| `cacheKeepWarmHours` | number | `6` | Claude on a subscription mode (see `anthropicSubscriptionModes`) only, where the prompt cache lasts one hour after its last use. While an idle session with at least 100k tokens of context still expects a wake (an open waitpoint, a worker that has not reported back, a background `agent` run), Cortex reads its cache about every 50 minutes so the wake does not re-send the whole context at the cache-write price. Each refresh is one short request on a fork of the session that leaves the conversation unchanged; it costs roughly a tenth of the context's input price and is recorded in costs under the `cache-refresh` trigger. Refreshing stops this many hours after the session last called the model. A cache that may already have expired, such as one whose last refresh came before a server restart, is not refreshed; that session's wake resumes cold. `0` turns it off; `0` through `24` | — |
| `coldResumeClearToolResults` | boolean | `true` | Claude only. When a session with at least 100k tokens of context resumes after its prompt cache has expired (more than 65 minutes since the cache was last used), Cortex replaces the output of all but the 10 most recent tool calls since the last compaction with a short placeholder in its transcript before Claude re-reads it, so the uncached request is smaller. Tool calls, the model's replies, your messages, subagent records, and short tool output that the placeholder would not shrink stay as they were; the model does not see the old tool output and re-runs a tool when it needs that output again. The transcript is left unchanged when this would remove less than 40,000 characters. Rewinding or retrying the turn restores the full transcript | — |
| `uiCorsOrigins` | string[] | `[]` | Origins that receive CORS headers from the Web UI HTTP host. See [desktop-app.md](./desktop-app.md) | `CORTEX_UI_CORS_ORIGINS` (comma-separated) |
| `adminChannel` | string \| null | `null` | Slack channel for system notices (startup, rate-limit, disk alerts). The first DM to the bot is auto-detected and persisted here | `SLACK_ADMIN_CHANNEL`, then `CORTEX_ADMIN_CHANNEL` |
| `feishuAdminChannel` | string \| null | `null` | Feishu admin `chat_id` (`oc_...`) for the same notices. Independent of `adminChannel` — Slack channel ids are not usable on Feishu | `FEISHU_ADMIN_CHANNEL` |

The Web workbench writes a subset of these from **Settings → Notifications**
(`turnNotify`, `autoResume`, `notifyCompaction`), **Settings → Advanced**
(`disableUserContext`, `teamEnabled`, `claudeWindowWarmupEnabled`, `maxContextTokens`,
`piCompactReserveTokens`, `serverUpdateDisable`, `serverAutoUpdate`,
`sessionRetentionDays`, `memoryIndexRegenEnabled`, `memoryIndexRegenIntervalMs`,
`diskMonitor` and `eventLog`), **Settings → Platform** (`showToolCalls`,
`adminChannel`, `feishuAdminChannel`, `feishuSkillsInWeb`), **Settings → Privacy** (`telemetryEnabled`),
and the desktop/mobile **Usage**
screens (`providerRateLimits`). Every other key is edited by hand in the file.

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
provider renames that label, the old entry stops matching. Policy edits
apply only to future quota observations; an already-active quota or outage
window keeps its current state until its reset time or a manual **Resume now**
clear. The Codex and Anthropic cards also show the account's banked resets and
a confirmed **Reset** action; see
[Account usage and banked resets](./backends.md#account-usage-and-banked-resets).

Built-in job intervals must be integer milliseconds from `1000` through
`2147483647`, the safe range for Node timers. Enabled jobs run once at daemon
startup. Memory-index runs never overlap; a changed interval takes effect
after an active run finishes.

`sessionRetentionDays` is the one numeric retention control in **Settings →
Advanced → Data & maintenance**. The desktop Web UI writes it through the same
`config.set { section: 'settings' }` path as the boolean runtime toggles, and
the client enforces the same upper bound the server validates.
`piCompactReserveTokens` sits in the **Agent** section and takes the same path; the
client accepts `1024`–`131072`, exactly what the server validates. Cortex writes
it into PI's private `settings.json` when a PI session is created, so a new value
reaches the next PI session without a restart — sessions already pooled keep the
reserve they were built with.

`maxContextTokens` sits in the **Agent** section too. Its field accepts `100000`–`1000000`;
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
`CORTEX_NOTIFY_COMPACTION=0`/`false`/`off`/`no`, a comma-separated list for
`CORTEX_UI_CORS_ORIGINS`, and so on. Precedence is always: key in `settings.json` → legacy variable →
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
`.env` keeps its variables, and the server keeps running on whichever source
supplies each value — so a failed migration costs nothing but the deprecation
warnings.

### What stays in .env

Three categories of variables deliberately remain in `.env`:

- **Secrets and credentials** — `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
  `SLACK_APP_TOKEN`, `FEISHU_APP_ID`, `FEISHU_APP_SECRET`,
  `ANTHROPIC_API_KEY`, `CORTEX_CLIENT_TOKEN`, `CORTEX_WEBHOOK_TOKEN`. They are
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
cwd (`.claude/settings.local.json`, then `.claude/settings.json`) and its user
settings file in Cortex's Claude config directory (next section). Cortex does
not scaffold, sync, or overwrite those project-local cwd files at all; "never
overwrite" here applies only to the `$CORTEX_HOME/.claude/settings.json` seed
path above.

The file follows Claude Code's settings format with `hooks` and
`permissions` sections. See [hooks.md](./hooks.md) for the hook
system documentation. It has nothing to do with the Cortex runtime
settings in [`config/settings.json`](#configsettingsjson).

## Claude Code config directory

Every `claude` process Cortex starts — session engines, subagent children, and
the `claude auth login`, `status` and `logout` commands behind the login flow —
runs with `CLAUDE_CONFIG_DIR=$CORTEX_HOME/data/claude`, whatever the daemon's
own environment holds. It is Cortex's private Claude Code home, the counterpart
of PI's `$CORTEX_HOME/data/pi`: transcripts (`projects/<encoded cwd>/<id>.jsonl`),
the user settings file, user- and local-scope plugins, `.claude.json` and the
login all live there. A terminal `claude` working from `~/.claude` and Cortex
never see each other's sessions, settings or plugins. The `claude` binary itself
still comes from `PATH`.

**Login.** The directory has a login of its own; Cortex never copies or links
the terminal's `.credentials.json`, because each OAuth refresh rotates the token
and two copies would invalidate each other. Sign in from **Settings → Accounts**,
with `!login cc` in chat, or with `cortex auth login --backend claude` (see
[Remote login](./backends.md#remote-login)). On macOS the CLI keeps the login in
the keychain item `Claude Code-credentials-<first 8 hex of sha256(config dir)>`.

**`settings.json`.** The user settings file belongs to Cortex. When it does not
exist, the server creates it at startup from the `model`, `effortLevel`,
`modelSettings`, `autoCompactWindow`, `autoMemoryEnabled`, `env` and `attribution` keys of
`~/.claude/settings.json`; once it exists the terminal file is never read again.
The session-retention coordinator keeps one key in it current —
`cleanupPeriodDays`, from the `sessionRetentionDays` runtime setting — and
leaves every other key as it is. Edit the file directly to change what Cortex's
Claude sessions use.

**Plugins.** Plugins Cortex's Claude sessions should load are installed into
this directory:

```bash
cd ~/.cortex
CLAUDE_CONFIG_DIR=$HOME/.cortex/data/claude claude plugin install <plugin>@<marketplace> --scope project
```

Project- and local-scope installs record the plugin in
`$CORTEX_HOME/.claude/settings*.json` and the plugin files under
`$CORTEX_HOME/data/claude/plugins/`.

**Sessions from `~/.claude`.** At startup the server moves, once, every file a
live Claude session in the session registry owns under `~/.claude/projects` —
its transcript, its turn backups and its sidecar directory — to the same path
under `$CORTEX_HOME/data/claude/projects`, so those sessions keep resuming. A
destination that already exists is never overwritten, and files no registry
session owns stay where they are.

## Boards

A board is the status page of a long task, kept by the agents working on it
(see [Boards](./team.md#boards) in the team guide). Each board lives in
`<project context>/boards/<slug>/`, and `data/boards.json` lists every board
with its project, title and when it was last used. On upgrade, registered commissions from
earlier Cortex releases become boards: their directories move from
`commissions/` to `boards/`, and their files are moved, never deleted.

Boards are styled by a preset stylesheet that ships with Cortex in
`agent-server/defaults/board/board.css`. It is read from the package and never
copied into `$CORTEX_HOME`, so every upgrade brings its current version. The
preset uses only the app's theme variables (`--proto-*`, `--material-*`,
`--border-card`, `--r-*`, and the faces `--font-ui` and `--font-code`), so
boards follow light and dark mode, the palette and the accent.

To restyle every board, create `$CORTEX_HOME/config/board.css`. The file does
not exist by default. It loads after the preset, so it can redefine any
variable, the preset's own `--b-*` or a theme `--proto-*`, or override any
rule:

```css
:root { --proto-accent: #0f766e; --b-gap: 16px; }
.h { font-size: 14px; }
```

Open boards pick up a save within a few seconds, and deleting the file
restores the preset.

## Built-in assets and your overrides

Cortex's plugins, hooks, rules, subagent roles and system prompts ship in the
install's `agent-server/defaults/` and are read from there at runtime. They are
never copied into `$CORTEX_HOME`, so they always match the running version, and
`$CORTEX_HOME` holds only your own files. A file of yours at the matching place
replaces the built-in one, a new name adds to them, and deleting your file
brings the built-in one back.

| Asset | Built in | Yours | How yours combine with the built-in ones |
|---|---|---|---|
| Plugins | `defaults/plugins/<id>/` | `plugins/<id>/` | Same id: your skills replace or add to the built-in ones and your `mcp.json` replaces the built-in one; the manifest stays built in. Any other id is a plugin of its own. See [Built-in plugins](./skills-and-plugins.md#built-in-plugins) |
| Hook declarations | `defaults/config/hooks/*.json` | `config/hooks/*.json` | Same file name: each top-level field it sets replaces that field of the built-in declaration as a whole, so `{ "enabled": false }` switches a built-in hook off. See [the hook registry](./hooks.md#the-hook-registry) |
| Hook scripts | `defaults/hooks/*.mjs` | `hooks/*.mjs` | Same file name: replaces the built-in script |
| Rules | `defaults/rules/*.md` | `rules/*.md` | Same file name: replaces the built-in rule |
| Subagent roles | `defaults/agents/*.md` | `config/agents/*.md` | Same file name: replaces the built-in role |
| System prompts | `defaults/prompts/systemPrompts/*.md` | `prompts/systemPrompts/*.md` | Same file name: replaces the built-in prompt |
| Clean-mode workspace prompt | `defaults/prompts/clean-workspace.md` | `prompts/clean-workspace.md` | Replaces the built-in text; see [Clean mode](#clean-mode) |

Rules are Markdown files for agent sessions. A rule without `paths` frontmatter
is prepended to every session whose environment loads rules (`loadRules`); a
rule whose `paths` globs match a file the session reads is injected then by the
`rules-loader` hook, once per session.

Settings edits — a skill, a hook switch, a system prompt — are written to
`$CORTEX_HOME` in the same way, and Cortex never writes to the install. A sealed
home (`CORTEX_CONFIG_IMMUTABLE=1`, as in a benchmark trial) declares its whole
surface itself and uses none of the built-in plugins, hooks or rules.

A home set up by a release that kept copies of these files in `$CORTEX_HOME` is
converted on its first start: copies identical to the shipped files are removed,
plugin and hook copies that differ are moved to
`config/archive/builtin-overlay-<timestamp>/`, edited rules, roles and prompts
stay as your overrides, a switched-off built-in hook keeps its switch, and each
environment keeps loading the same plugins.

## defaults/ layout

The `agent-server/defaults/` directory in the npm package contains the
shipped defaults. The scaffold files are copied to `$CORTEX_HOME/` during init,
and the execution environments are also merged at every server start; the
built-in assets are read in place:

| Source | Destination | Overwrite behavior |
|---|---|---|
| `defaults/AGENTS.md` | `$CORTEX_HOME/AGENTS.md` | Never |
| `defaults/gitignore` | `$CORTEX_HOME/.gitignore` | Never |
| `defaults/.claude/settings.json` | `$CORTEX_HOME/.claude/settings.json` | Never — this applies only to the `$CORTEX_HOME/.claude/settings.json` scaffolded path; arbitrary repository-local `.claude/settings.json` files are outside Cortex's copy/sync loop |
| `defaults/config/budget.json` | `$CORTEX_HOME/config/budget.json` | Only with `--force` |
| `defaults/config/environments/` | `$CORTEX_HOME/config/environments/` | Per-file copy-if-missing, at init and again at every server start: a shipped environment you do not have yet is added; a file you already have is never overwritten — `--force` does not apply to this tree |
| `defaults/data/schedules.json` | `$CORTEX_HOME/data/schedules.json` | Never (unless `--force`) |
| `defaults/context/` | `$CORTEX_HOME/context/` | Index `AGENTS.md` files: never overwritten. The `decisions/` scaffold: only with `--force` |
| `defaults/plugins/`, `defaults/config/hooks/`, `defaults/hooks/`, `defaults/rules/`, `defaults/agents/`, `defaults/prompts/` | — | Not copied: read in place, with your files laid over them (see [Built-in assets and your overrides](#built-in-assets-and-your-overrides)) |
| `defaults/board/` | — | Not copied: the board preset stylesheet and the scaffold of a new board are read from the package |

Init also generates `config/machines.json`, `config/preferences.json` and
`data/agent-state.json` when they are missing (or with `--force`), writes the
`config/mcp-config*.json` files, and sets up the gateway configuration and
`models.json` (see [`cortex init`](./cli-reference.md#commands)). The server
rewrites the `mcp-config*.json` files at every start, so edits to them do not
persist.

An upgrade therefore brings the current built-in plugins, hooks, rules, roles
and prompts with it, and newly shipped environments reach existing installs
without touching your edits. Whole-file config such as `budget.json` requires
`--force` to replace.

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
- **`models.json`** — cached and watched for parseable JSON changes. An
  update refreshes the cache before the next agent spawn; malformed JSON keeps
  the previous model configuration.
- **`machines.json`** — watched and reloaded after valid changes. Invalid
  entries keep the previous machine registry.
- **`environments/`** — watched. Changes are debounced (300 ms) and every
  environment is reloaded without a restart. See
  [Execution environments](#execution-environments).
- **`.env`** — requires a daemon restart to pick up changes (loaded once
  at startup via dotenv). Behavior settings live in `config/settings.json`,
  which does not.
- **Hook declarations (`config/hooks/*.json`)** — the registry is re-read on
  every agent spawn, so a new `agent:*` / `cc:*` / `pi:*` entry applies to the
  next agent that starts. `cortex:*` entries are snapshotted at server start
  and need a restart. See [hooks.md](./hooks.md).
- **Hook scripts** — read fresh on every hook invocation.
- **Plugins, prompts, rules, subagent roles** — read fresh on each agent session spawn.
- **`config/board.css`** — watched together with every board's directory. Open boards re-render within a few seconds of a change. See
  [Boards](#boards).

## Where each file lives

| File | Purpose | Path |
|---|---|---|
| `.env` | Environment variables | `$CORTEX_HOME/config/.env` |
| `settings.json` | Runtime behavior settings (hot-reloaded) | `$CORTEX_HOME/config/settings.json` |
| `models.json` | Default engine and favorite models | `$CORTEX_HOME/config/models.json` |
| `environments/` | Execution environments — one JSON per environment | `$CORTEX_HOME/config/environments/` |
| `machines.json` | Machine registry | `$CORTEX_HOME/config/machines.json` |
| `budget.json` | Budget limits | `$CORTEX_HOME/config/budget.json` |
| `preferences.json` | UI language for system messages | `$CORTEX_HOME/config/preferences.json` |
| `mcp-config*.json` | Generated MCP server configs (rewritten at every start) | `$CORTEX_HOME/config/` |
| `.claude/settings.json` | Claude Code hooks/permissions (not the Cortex settings file) | `$CORTEX_HOME/.claude/settings.json` |
| `agent-state.json` | Channel selections, model memory, new-session choice, default agent | `$CORTEX_HOME/data/agent-state.json` |
| `schedules.json` | Schedules | `$CORTEX_HOME/data/schedules.json` |
| `boards.json` | Board registry | `$CORTEX_HOME/data/boards.json` |
| `provider-state.json` | Provider usage, throttle windows, resume queue | `$CORTEX_HOME/data/provider-state.json` |
| `waitpoints.json` | Waitpoints | `$CORTEX_HOME/data/waitpoints.json` |
| `board.css` | Optional stylesheet for every board | `$CORTEX_HOME/config/board.css` |
| `session-registry.jsonl` | Append-only session registry journal | `$CORTEX_HOME/data/session-registry.jsonl` |
| `retention-candidates.json` | Two-sweep orphan cleanup candidates | `$CORTEX_HOME/data/retention-candidates.json` |
| `conversation-history/` | Per-session transcript/history JSONL | `$CORTEX_HOME/data/conversation-history/` |
| `logs/sessions/` | Claude capture logs | `$CORTEX_HOME/logs/sessions/` |
| `logs/sessions-pi/` | PI transcript bundles | `$CORTEX_HOME/logs/sessions-pi/` |
| `hooks/*.json` | Your hook declarations and overrides | `$CORTEX_HOME/config/hooks/` |
