# CLI Reference

Cortex ships five binaries, registered in `agent-server/package.json`:

| Binary | Entry point | Purpose |
|---|---|---|
| `cortex` | `dist/entry/cortex-cli.js` | Server management and initialization |
| `cortex-browser` | `dist/entry/browser-cli.js` | Drive the session's agent browser |
| `cortex-evidence-export` | `dist/entry/production-evidence-export-cli.js` | Production benchmark evidence v2 export |
| `cortex-hook` | `dist/entry/hook-cli.js` | Hook inspection, switching, test runs, and blocking user asks |
| `cortex-signal` | `dist/entry/signal-cli.js` | Resolve a waitpoint from an external program |

All five accept `--help` (or `-h`) to print their usage.

---

## cortex

```
cortex <command> [options]
```

Server lifecycle and initialization CLI. `cortex --help` lists every command.

### Commands

**`cortex init [--home <path>] [--gateway-config-dir <path>] [--force] [--answers <file>] [--json]`**

Initialize `CORTEX_HOME`. The interactive wizard uses bundled PI by default
without a backend-selection prompt, collects platform (Slack / Feishu),
machine, usage-reporting, and service settings, writes `.env`, copies default
configs, and generates the `mcp-config*.json` files, `machines.json`,
`preferences.json` and `agent-state.json`. It also seeds `schedules.json`,
creates a git repository in `CORTEX_HOME` when `git` is available, and can
enable the local Web UI and install a system service when those answers ask
for it.

After writing configs, it detects local provider credentials and offers
login, rescan, continue with configured providers, or a warned skip. Login
uses the same flow as `cortex auth login`; choosing Claude Code reuses an
existing installation or asks permission to install a missing copy. Continue
configures gateway routes and asks for a default model and favorites from
detected endpoints. The recommended default is preselected and included among
favorites. Detection
makes no paid inference request and does not verify model access.

`--answers` and `--json` runs do not start provider login or wait for input.
They report credential status and can finish with provider setup incomplete.

Options:
- `--home <path>` — set `CORTEX_HOME` (default: `$CORTEX_HOME` or `~/.cortex/`)
- `--gateway-config-dir <path>` — gateway config output directory (default: `~/.aistatus/`)
- `--force` — overwrite existing configs (`.env`, `budget.json`, `agent-state.json`, etc.)
- `--answers <file>` — read answers from a JSON document without prompting. Omitted fields use defaults; `{}` creates a single-machine installation using PI, with provider login still required if no credentials are detected. Used by the desktop installer. An explicit `backends` array retains its selection and installation semantics (`claude`, `pi`, or both); an explicit empty array selects Claude.
- `--json` — emit newline-delimited progress events on stdout and move human-readable output to stderr. The final event reports the home directory, the version, the client token, and the local Web UI URL.

Model answers use this shape (the selected pair must be among detected models):

```json
{
  "defaultChoice": { "mode": "openai-codex", "model": "gpt-6.1-sol" },
  "favorites": [{ "mode": "openai-codex", "model": "gpt-6.1-sol" }]
}
```

An explicit `defaultChoice` replaces the saved default; otherwise it is preserved.
Favorites are merged and include the selected default. The positional stdin
protocol ends with two model lines: default `mode:model`, then comma-separated
favorite `mode:model` pairs.

**`cortex ui enable [--port <n>] [--home <path>] [--json]`**

Make this install reachable by the Cortex desktop app. Generates the client
token if it is missing, sets `CORTEX_UI_HTTP=1` and `CORTEX_UI_PORT`, and adds
the app's origins to `uiCorsOrigins`. Idempotent — running it twice changes
nothing the second time. Its output ends by pointing at `cortex ui pair`.

Restart the daemon when it reports that the configuration changed: `.env` is
read once at process start.

Options:
- `--port <n>` — the port to listen on. Without it, a `CORTEX_UI_PORT` already in `.env` is kept, and `3004` is used when there is none; an invalid port exits 1
- `--home <path>` — set `CORTEX_HOME` (default: `$CORTEX_HOME` or `~/.cortex`)
- `--json` — print `{ ok, home, url, token, port, changed }`

**`cortex ui pair [--home <path>] [--json]`**

Print a one-time pairing code (`XXXX-XXXX`) for a new app or browser. The code
is valid for 10 minutes and works once; enter it with the server's address in
the desktop or Android app, or on the browser sign-in page. The code is written
to `$CORTEX_HOME/data/ui-pairing.json`, which the running server reads, so no
restart is needed. Signed-in devices can create the same codes under
**Settings → Machines → Connected apps** (see
[Browser access](browser-access.md#pairing-codes-and-connected-apps)).

Options:
- `--home <path>` — set `CORTEX_HOME` (default: `$CORTEX_HOME` or `~/.cortex`)
- `--json` — print `{ ok, code, expiresAt }`

**`cortex client remove --device <name> [--keep-remote] [--dry-run] [--home <path>]`**

Retire a remote machine. The command deletes the machine's entry from
`config/machines.json`, connects to the machine over SSH, stops every process
running its client bundle, and deletes the bundle (`client/`),
`config/cortex-client.json`, and the `logs/client-*.log` files from the
client's `CORTEX_HOME`. It then drops the machine from `data/client-pids.json`
and `data/client-routes.json`. The registry entry goes first, so a running
server releases the machine's tunnel and restart timer on hot-reload instead of
relaunching the client that is being stopped.

The client's `CORTEX_HOME` comes from the bundle path in `clientCommand` and
defaults to `~/.cortex` (`%USERPROFILE%\.cortex` on Windows). A home that also
contains `config/machines.json` belongs to a Cortex server; there the client
process is stopped and every file stays in place. A machine that cannot be
reached is still removed locally, with `remote.status: "unreachable"` in the
result and a warning on stderr. The server's local machine (an entry without
`ssh`) is refused.

Output is JSON with the `device`, `removed_at`, the removed `machine_entry`,
the `runtime` pid and route that were dropped, and `remote` — `cleaned` (with
the `killed` pids and `files: removed | kept-server-home`), `unreachable`, or
`skipped`. `--dry-run` prints the plan under `would_remove` and changes nothing.

Options:
- `--device <name>` — machine name in `machines.json` (required)
- `--keep-remote` — only unregister locally; leave the remote process and files alone
- `--dry-run` — print what would be removed and change nothing
- `--home <path>` — set `CORTEX_HOME`

**`cortex path <install|remove|status> [--home <path>] [--dry-run] [--json]`**

Make this install's commands available in new terminals. `install` writes a
launcher for each binary above into `$CORTEX_HOME/runtime/bin`. The launcher
runs the Node.js that executed the command against this install's entry file,
so the terminal does not need Node.js on `PATH`. It then registers that
directory on `PATH`. On Linux and macOS it uses a block marked
`# >>> cortex >>>`. The block goes at the end of `~/.profile`, and of
`~/.bash_profile` and `~/.zshenv` (under `$ZDOTDIR` when set) where those
shells are in use. It goes at the top of `~/.bashrc`, so that non-interactive
SSH commands see it. On Windows the directory goes at the front of the user
`Path`, which keeps its registry type and announces the change to new
processes. Running `install` again rewrites only what differs. New terminals
use this install even when another `cortex` is on `PATH`; the result lists
those under `shadowed`. fish is not configured.

At startup the server re-points existing launchers when its Node.js or entry
path has changed. A server that the desktop app installed in
`$CORTEX_HOME/runtime/prefix` also runs `install` itself when no launchers
exist, unless `remove` was the last choice. `install` and `remove` record that
choice in `$CORTEX_HOME/runtime/terminal-cli.json`. `remove` deletes only the files this
command wrote and takes the directory back off `PATH`, which leaves the
profiles and the user `Path` as they were before `install`. `status` reports
whether the launchers exist, which are out of date, and where the directory is
registered.

Options:
- `--home <path>` — set `CORTEX_HOME`, which also becomes the launchers' default `CORTEX_HOME` (default: `$CORTEX_HOME` or `~/.cortex`)
- `--dry-run` — for `install` and `remove`, report the changes and write nothing
- `--json` — print `{ ok, action, dry_run, dir, … }`: `written` and `shadowed` for install, `removed` for remove, and `path_targets` with each profile file or `HKCU\Environment\Path` and whether it changed

**`cortex start`**

Run the server in the foreground: fork `dist/entry/app.js` with inherited
stdio and `$CORTEX_HOME` as its working directory, and exit with its exit
code. The process runs the platform adapters, the Web UI host, the webhook
server, and all agent orchestration, with no supervisor to restart it.

**`cortex daemon`**

Start the supervisor in the background and return at once. The command forks
`dist/entry/daemon.js` detached from the terminal, with no stdio (the daemon
writes its own logs under `logs/`), and exits 0. The daemon runs `app.js` as
its child, restarts it after a crash with exponential backoff, and drains and
respawns it when `$STORE_DIR/.restart` is touched. `cortex daemon --version`
prints the version.

**`cortex daemon stop`**

Send the daemon SIGTERM and wait up to 10 seconds for it to exit; a daemon
still alive after that is killed with SIGKILL and the command exits 1. The
daemon is stopped together with the client it launched on this machine (the
local client), so no Cortex process keeps running or keeps files of the
runtime in use; a local client that survives also exits 1. Clients on SSH and
custom-command machines keep running, and the next `cortex daemon` launches the
local client again. A daemon that is not running, including a stale PID file,
which is cleaned up, exits 0.

**`cortex daemon status`**

Print the daemon's PID and uptime and the state of its `app.js` child (PID and
uptime, `starting...`, or `none`).

**`cortex daemon restart [--hard | --force]`**

Without a flag, touch the restart trigger so the daemon drains and respawns
`app.js`. `--hard` sends SIGTERM straight to `app.js` and `--force` sends
SIGKILL; either way the daemon starts a new child. All three exit 1 when no
daemon is running; the flags also exit 1 when no `app.js` child is alive.

**`cortex daemon restart-self`**

Stop the daemon as `cortex daemon stop` does, then start a new detached daemon.

**`cortex restart`**

Touch the restart trigger at `$STORE_DIR/.restart` and print its path. A
running daemon drains and respawns `app.js`; with no daemon running the command
only creates the file. It exits 1 when the file cannot be written.

**`cortex tui [--resume] [--project <id>] [--port <n>]`**

Open the terminal chat client against a running server. The command checks
that the TUI gateway is listening on `127.0.0.1:<port>` and exits 1 with a hint
to start the daemon when it is not; otherwise it runs the client in the
terminal and exits with its exit code.

Options:
- `--resume` — open the resume-session picker on connect
- `--project <id>` — start a fresh session in that project
- `--port <n>` — the gateway port (default: `$CORTEX_TUI_PORT`, else `3003`)

**`cortex install latest`**

Update the server from npm. The command asks npm for the latest
`@cortex-agent/server` version, prints `Already on the latest version` when the
running install is current, and otherwise runs `npm install -g` for that version
into `CORTEX_NPM_PREFIX`, else the running install's own prefix. Restart the daemon
afterwards with `cortex daemon restart`. A failed lookup or install exits 1.

**`cortex config`**

Print resolved paths and initialization status. Shows `INSTALL_ROOT`,
all data directories, and whether `.env`, `mcp-config.json`, and
`agent-state.json` exist.

**`cortex doctor [--fix] [--json]`**

Health-check the whole installation in one pass and report what is wrong.
The default run is read-only and safe at any time. It inspects four areas:

- Runtime & process — Node version, `git` on PATH (a failure on Windows, a
  warning elsewhere), the `claude` binary on PATH (a warning when missing; PI
  always passes, since it runs in-process from the bundled SDK), and whether the
  daemon is running.
- Backend install / login — data directories exist and are writable, `.env`
  is present, the client and webhook tokens are set, `ANTHROPIC_API_KEY`
  status, and that `agent-state.json`, `models.json`, and `mcp-config.json` are
  present and valid. A missing `models.json` is a warning; invalid JSON, an
  invalid default selection, or a missing or invalid favorites array is a failure. It also smoke-tests the installed PI runtime and its
  `login` export, then summarizes expired or logged-out in-use providers from
  the credential-free backend auth snapshot. These two checks warn rather than
  fail. In API mode, a healthy gateway with no local key is reported as
  gateway-backed information instead of a false logged-out warning.
- Messaging platform — resolves `CORTEX_PLATFORM` and validates the
  credentials for each enabled platform (Slack `xoxb-`/signing/`xapp-`,
  Feishu app id/secret).
- Gateway — the configured gateway YAML's presence and a health probe of
  `http://127.0.0.1:<CORTEX_GATEWAY_PORT>/status` (default port `9880`).
  Its directory follows `CORTEX_GATEWAY_HOME`, defaulting to `~/.aistatus/`.
  The probe is reported as a failure only
  when the gateway is actually in use; otherwise it is skipped.

Each check prints `[OK]`, `[WARN]`, `[FAIL]`, or `[--]` (skipped) with a
short detail and, for problems, a fix hint. The command exits `1` when any
check fails, else `0`; warnings do not fail the run.

Options:
- `--fix` — apply safe, idempotent repairs only: create missing data
  directories, create a missing `.env`, generate missing auth tokens, and
  rebuild `mcp-config.json`. The JSON report lists them under `fixes`.
  It never deletes configuration or overwrites existing credentials. After
  fixing, diagnostics re-run so the summary reflects the repaired state.
- `--json` — emit the full report (sections, checks, counts) as JSON for
  scripting.

**`cortex auth status [--json]`**

Read the normalized Claude Code and PI authentication snapshot. The default
text output shows a concise status overview, while `--json` returns the full
`AuthStatusSnapshot` for scripting. Both forms omit credential values and
fragments.

This subcommand is read-only and reports local credential state, not live
inference validation. Sign in locally with `cortex auth login`. Remote login
starts from `!login` in Slack or Feishu, or **Settings → Accounts** in the Web
UI; mobile users drill in at `/m/settings/accounts`.

Options:
- `--json` — print the complete credential-free status snapshot as JSON
- `--help`, `-h` — show auth command help

See [Backends: Remote login](./backends.md#remote-login) for login commands,
provider capability rules, and expiration handling.

**`cortex auth login [--backend pi|claude] [--provider ID] [--auth-type oauth|api_key]`**

Sign in to a provider from an interactive terminal without a running daemon.
Omitted options are selected interactively from the backend's supported
providers and authentication methods. PI is bundled. For Claude Code, an
existing installation is reused; a missing installation requires confirmation
before Cortex installs it and starts login.

Login requires TTY stdin and stderr, even when all selectors are supplied.
API keys and authorization responses are entered through secret prompts;
this command accepts no key, token, or authorization-code arguments. Browser
links and device instructions appear on stderr. Non-TTY login fails promptly
without starting an authentication flow; help works without a TTY.

The result is JSON on stdout, with human prompts and errors on stderr; no
`--json` flag is needed or accepted. Results omit secrets. A successful login
synchronizes gateway/model configuration and reports the sync result with
`inferenceVerified: false`: credentials are configured, not inference-tested,
and no paid model request is sent.

Options:
- `--backend pi|claude` — choose the backend; omitted means select interactively
- `--provider ID` — choose a provider supported by that backend's runtime
- `--auth-type oauth|api_key` — choose a supported authentication method
- `--help`, `-h` — show login help without starting login

```bash
cortex auth login
cortex auth login --backend pi --provider anthropic --auth-type api_key
cortex auth login --backend claude --provider anthropic --auth-type oauth
cortex auth login --help
```

**`cortex auth provider <list|add|remove> [options]`**

Manage custom PI providers — self-hosted or proxied endpoints that have no
login flow of their own. `add` is an upsert, so re-running it with a changed
URL or model list edits the stored definition in place.

Options:
- `--name <name>` — provider name; letters, digits, `-` and `_` only
- `--api <api>` — request protocol: `anthropic-messages`, `openai-completions`, `openai-responses`, or `google-generative-ai`
- `--url <url>` — upstream endpoint, stored in the gateway route
- `--key <key|->` — upstream API key; `-` reads it from stdin so it never appears in shell history
- `--model <id>` — a model id the endpoint serves; repeat for several
- `--dry-run` — on `remove`, report what would be deleted without deleting it
- `--json` — print the result as JSON
- `--help`, `-h` — show provider command help

```bash
# define a local endpoint that speaks the Anthropic protocol
cortex auth provider add --name my-vllm --api anthropic-messages \
  --url http://127.0.0.1:8100 --model Model-27B

# take the key from a secret store instead of the command line
pass show my-endpoint | cortex auth provider add --name my-proxy \
  --api openai-completions --url https://proxy.example.com/v1 --model small --key -

cortex auth provider list --json
cortex auth provider remove --name my-vllm --dry-run
```

See [Backends: Custom providers](./backends.md#custom-providers) for what the
two writes contain and how a definition reaches an agent.

**`cortex setup-gateway [--dry-run] [--output-dir <path>]`**

Auto-detect Claude Code and PI configurations from their local config
files, generate the gateway YAML (with backup of existing),
and write `$CORTEX_HOME/config/models.json`. Run this whenever you add
a new API key or change models. The default output is
`~/.aistatus/gateway.yaml`; `CORTEX_GATEWAY_HOME` selects
`<CORTEX_GATEWAY_HOME>/.aistatus/gateway.yaml`, and `CORTEX_GATEWAY_PORT`
sets its port. Both settings may be saved in `$CORTEX_HOME/config/.env`; see
[Local model gateway](./configuration.md#local-model-gateway) for multi-instance setup.

Options:
- `--dry-run` — print the generated gateway.yaml to stdout without writing
- `--output-dir <path>` — write gateway.yaml and models.json under `<path>` instead of defaults; this exports files and does not change the running gateway location

Setup preserves an existing default selection and merges favorites. Its summary
shows the default model and favorites; use **Settings → Models** to change the
default. Provider-login sync also preserves existing choices, supplies a missing
default, and adds a recommended favorite for each newly connected backend/provider
group without one. Its result includes `defaultSet` and `favorites`.

**`cortex schedule <list|get|add|edit|pause|resume|remove> [<id>] [options]`**

Manage scheduled tasks — the same records `!schedule` and the Web UI manage.
Each fire opens a new session in the schedule's project
and sends it the message; see [Scheduling](./scheduling.md). Changes are written
to `schedules.json`, and a running daemon picks them up within a second.

Agents use this CLI through the `schedule` skill. For a session-project request,
resolve the project from session context or `cortex_context` and pass `--project`
explicitly; if the requested current project is missing, ask which one to use.
The CLI does not infer session scope from Bash environment variables. Daily/weekly
times use the daemon's local timezone (including `TZ` overrides); convert the
user's timezone and weekday explicitly and report the next run in their timezone.
There is no per-schedule timezone or automatic cross-timezone daylight-saving adjustment.

Every command prints JSON with `ok: true` and the schedule (`schedule`, or
`schedules` and `count` for `list`); timestamps are ISO 8601. Invalid input
exits 1 with the valid values on stderr.

- `list [--project <id>]` — all schedules, or one project's
- `get <id>` — one schedule; an unknown id exits 1
- `add --type <type> …` — create a schedule; prints `created: false` and the existing schedule when `--idempotency-key` matches one. A timing flag that does not belong to the type is rejected
- `edit <id> …` — change the message, project, model selection, pre-check, or the timing fields of the schedule's type; the type itself is fixed
- `pause <id>` / `resume <id>` — pause or resume a recurring schedule; repeating either changes nothing
- `remove <id> [--dry-run]` — delete a schedule (`removed: false` when it does not exist); `--dry-run` prints `would_remove` and deletes nothing

Options:
- `--type interval|daily|weekly|once` — schedule type (`add` only)
- `--interval <duration>` — `interval`: repeat period, e.g. `30m`, `2h`, `1d`
- `--time <HH:MM>` — `daily`/`weekly`: 24-hour time, server local time
- `--day <day>` — `weekly`: `sun`..`sat` or `0`-`6`
- `--delay <duration>` — `once`: fire this long from now; on `edit`, moves the fire time
- `--message <text|->` — the prompt for the fired session; `-` reads it from stdin
- `--project <id>` — project the fired session belongs to (default: `general`)
- `--model <[provider/]model>` — model to run; PI accepts an explicit `provider/model`. Creation without model flags stores the configured default selection, which may differ from the active session
- `--thinking <level>` — backend-native thinking level. With no model flag, applies to a copy of the configured default on creation or the schedule’s stored selection on edit; omitted on a model change, uses that model’s remembered level
- `--pre-check <cmd>` — shell gate run before each fire; a non-zero exit skips that fire
- `--idempotency-key <key>` — `add`: a retry with the same key returns the first schedule
- `--help`, `-h` — show schedule help

```bash
cortex schedule add --type interval --interval 30m --project nimbus \
  --message "Check GPU usage on lab2 and report a one-line summary"
cortex schedule add --type weekly --day mon --time 21:00 --message "Weekly review"
echo "Check training run r42 on lab2" | cortex schedule add --type once --delay 2h --message -
cortex schedule list --project nimbus
cortex schedule edit a1b2c3d4 --time 10:30
cortex schedule remove a1b2c3d4 --dry-run
```

**`cortex memory <regen|consolidate> [--project <name>]... [--text]`**

Maintain project memory under `$CORTEX_HOME/context/projects/*/` (its
`experiments/`, `knowledge/` and `patterns/` directories; see
[Memory](./memory.md)). `--project` limits the run to one project and can be
repeated; without it every project with memory directories is processed, and an
unknown project exits 1 with the valid names.

- `regen` — rebuild the generated `index.md` files from entry frontmatter and
  the access log, never touching the `EXP`/`K`/`PAT` entries themselves. Prints
  `{ ok: true, projects: [{ project, indexes }] }`.
- `consolidate` — report contradictions, stale entries, anti-pattern signals and
  consolidation candidates as `{ ok: true, reports }`; `--text` prints a
  readable summary instead.

**`cortex feishu <login|status|logout> [--scope <scopes>] [--manual] [--redirect-uri <url>]`**

Manage the Feishu user identity that Feishu document tools act as.

- `login` — authorize a Feishu account with the OAuth device flow: the command
  prints a URL and a code to open in any browser. It needs `FEISHU_APP_ID` and
  `FEISHU_APP_SECRET`. On success it stores the user token and writes
  `FEISHU_AUTH_MODE=user` to `.env`; restart the daemon to apply it.
- `status` — show the auth mode (`user` or `bot`) and the stored token's
  validity and expiry.
- `logout` — delete the stored user token.

Options:
- `--scope <scopes>` — the scopes to request (default: `$FEISHU_USER_SCOPE`, else a document, sheet, base and wiki set that needs no app review; `offline_access` is always added)
- `--manual` — use the authorize-URL and paste-the-code flow instead of the device flow
- `--redirect-uri <url>` — redirect URI for `--manual` (default: `$FEISHU_REDIRECT_URI`)

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (invalid command, missing config, runtime failure) |
| 130 | `init` or `auth login` cancelled, or the Claude Code install declined |

`cortex start` and `cortex tui` exit with the code of the process they run.

---

## cortex-browser

```
cortex-browser [--device <name>] <agent-browser command> [args...]
```

Drive the calling session's tab in the [agent browser](./agent-browser.md). Agents run it from
their shell; every argument except `--device` is passed to the pinned
[agent-browser](https://agent-browser.dev), attached to the session's own tab. Its output and exit
code are agent-browser's. `cortex-browser skills get core` prints agent-browser's command guide for
the shipped version, and `--full` adds every command and option.

Options:
- `--device <name>` — whose Chrome: `server` or a connected device. The choice sticks for the session (default: the session's last device, else `server`)
- `--help`, `-h` — show usage; `cortex-browser <command> --help` shows one agent-browser command

Each call asks the daemon for the session's browser over the loopback webhook
(`http://127.0.0.1:$WEBHOOK_PORT/webhook/browser`, authenticated with `CORTEX_WEBHOOK_TOKEN`). The
session comes from `CORTEX_SESSION_ID` (or `CORTEX_EXECUTION_ID`). Agent shells carry all three,
so the command needs no setup there. `skills`, `help` and `--version` run without a browser.

Relative paths given to file commands (`screenshot`, `pdf`, `download`, `upload`, `record`,
`trace`, `har`, `state`, …) and to `--screenshot-dir`, `--download-path` and `--baseline` resolve
against the caller's working directory.

`cortex-browser` sets `--cdp`, `--session` and the tab binding itself, and refuses flags that would
leave the session's tab: `--cdp`, `--session`, `--no-pin-tab`, `--auto-connect`, `--provider`/`-p`,
`--namespace`, `--engine` and `--executable-path`. It also refuses `connect`, `install`,
`upgrade`, `dashboard`, `mcp` and `close --all`, each with the reason and what to use instead.

When the session's tab is gone (closed after 10 idle minutes, or Chrome restarted), the call opens
a new blank tab, prints a note on stderr, and runs the command there.

### Exit codes {#cortex-browser-exit-codes}

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | The agent-browser command failed, or no browser could be used: unknown or offline device, Chrome failed to start, the user is controlling the browser, the daemon is unreachable or rejected the token. The reason and a hint are on stderr |
| 2 | Usage error (a refused flag or command, `--device` without a name) or no session in the environment |

Once the browser is attached, the exit code is agent-browser's own.

### Examples {#cortex-browser-examples}

```bash
# Open a page and list what can be clicked
cortex-browser open http://127.0.0.1:5173 && cortex-browser snapshot -i

# Click a ref from the snapshot, then capture the result
cortex-browser click @e2 && cortex-browser screenshot ./after-click.png

# Use the Chrome on the user's machine (its localhost, its logins)
cortex-browser --device my-pc open https://example.com

# Read the version-matched command reference
cortex-browser skills get core --full
```

---

## cortex-evidence-export

```
cortex-evidence-export --input-file <path|->
```

Publish immutable terminal/composite benchmark evidence v2 from the production stores under
`CORTEX_HOME`. The command initializes the production attempt identity and journal stores, loads
`data/executions.json`, reads attributed costs, then delegates validation and atomic publication to
`exportProductionBenchmarkEvidence`. Cortex benchmark arms always run through the production
server, as one direct session per trial; this command records that runtime's stores and does not
define a second orchestration path.

Evidence is keyed by session and execution: every run the trial's session opened is one attempt,
identified by its `session_id` and `execution_id`, and each later run of the session is a spawn
child of the run before it.

`--input-file` contains one JSON-encoded `ProductionEvidenceExportInput`; use `-` to read it from
stdin. The arguments must be exactly `--input-file <value>`; anything else is a usage error. The launcher owns every field: `outputDirectory`, `trialId`, `rootRunId`, `armName`,
`armCanonicalSha256`, `bundleManifestHash`, `proxyExport`, and optional `evaluatedChecks`. Hashes,
proxy trial identity, and predicate results are validated before publication. Missing or malformed
input, incomplete durable records, or an existing output directory fail closed with exit code `1`.

```bash
cortex-evidence-export --input-file production-evidence.json
cat production-evidence.json | cortex-evidence-export --input-file -
```

Success writes one JSON object to stdout:

```json
{"ok":true,"directory":"/evidence/run-1","composite_path":"/evidence/run-1/composite-manifest.json","composite_sha256":"<sha256>","terminal_paths":["/evidence/run-1/execution-root.terminal.json"]}
```

Failure writes `{"ok":false,"error":"..."}` to stderr and does not publish a partial directory.
The public output path appears only after all terminal and composite bytes are written, fsynced,
and verified in a hidden staging directory.

---

## cortex-hook

```
cortex-hook <list|show|enable|disable|test|ask> [options]
```

Inspect and operate the hooks mounted from the built-in registry and
`$CORTEX_HOME/config/hooks/`. Every command prints JSON on stdout and errors on
stderr. [Hooks: the cortex-hook CLI](./hooks.md#the-cortex-hook-cli) covers the
registry these commands act on.

- `list` — every mounted hook: `id`, `event`, `enabled`, `source` (`builtin` or `user`), and whether a user file overrides a built-in one
- `show --id <id>` — one complete declaration; an unknown id exits 1 and lists the valid ones
- `enable --id <id> [--dry-run]` / `disable --id <id> [--dry-run]` — switch a hook, idempotently; the result says whether anything `changed`, and `--dry-run` reports `would_set` without writing
- `test --id <id> --payload <file|->` — run the hook once with the payload on stdin and print its `exit_code`, `stdout` and `stderr`; the command exits with the hook's own exit code
- `ask (--question <text> | --payload <file|->)` — post an ask-user card and block until it is answered, then print `{ ok: true, answers }`. `--header`, `--options "a|b|c"`, `--multi` and `--level info|warn|warning|error` shape a single question; `--payload` takes a JSON array of question objects. The card goes to `--channel` (default: `$CORTEX_HOOK_CHANNEL`) or the channel of `--session-id` (default: `$CORTEX_HOOK_SESSION_ID`), both of which a hook's environment already carries. `--dry-run` resolves synthetically without posting. See [Asking the user from a hook](./hooks.md#asking-the-user-from-a-hook)

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success, or an answered `ask` |
| 1 | Usage or runtime error |
| 2 | `ask` timed out unanswered |

`test` exits with the code of the hook it ran.

---

## cortex-signal

```
cortex-signal [--id wp_…] [--secret …] [--status ok|fail|progress] [--message TEXT] [--exit-code N]
```

Tell Cortex that something it is waiting for has finished. Run without
arguments, it prints its usage. The agent arms a
waitpoint with the `wait_create` MCP tool and ends its turn; this command
resolves that waitpoint and wakes the session. See
[waitpoints.md](./waitpoints.md) for the full picture.

`--id` and `--secret` default to `$CORTEX_SIGNAL_ID` and
`$CORTEX_SIGNAL_SECRET`, so the usual integration is two lines: export them
once, then append one command.

Options:
- `--id <wp_…>` — waitpoint id (default: `$CORTEX_SIGNAL_ID`)
- `--secret <hex>` — the capability issued with that waitpoint (default: `$CORTEX_SIGNAL_SECRET`)
- `--status <s>` — `ok`, `fail`, or `progress` (default: `ok`). `ok`/`fail` are terminal: they count toward the quorum and wake the session. `progress` records a heartbeat without resolving anything and **without waking anyone** — the difference between the two is entirely "is this worth a turn"
- `--exit-code <n>` — derive the status from a command's exit code (0 = `ok`, anything else = `fail`) and default the message to `exit=<n>`
- `--message <text>` — one-line summary shown in the wake message
- `--member <name>` — which member of a multi-job waitpoint this signal is for
- `--data <@file|-|text>` — extra payload from a file, stdin, or the literal text; it reaches the agent labelled as data, never as instructions
- `--url <url>` — daemon signal endpoint (default: `http://127.0.0.1:$WEBHOOK_PORT/webhook/signal`)
- `--no-spool` — fail instead of spooling to disk when the daemon is unreachable
- `--help`, `-h` — show usage

The endpoint is loopback-only and does **not** accept `CORTEX_WEBHOOK_TOKEN`:
the per-waitpoint secret is the only credential, and it can do nothing except
resolve its own waitpoint. To signal from another machine, drop a JSON file in
`~/.cortex/tmp/signals/` there instead — see
[waitpoints.md](./waitpoints.md#on-another-machine).

### Spooling

If the daemon cannot be reached, the signal is written to
`$CORTEX_HOME/tmp/signals/<name>.json` (`.tmp` first, then renamed, so a
half-written file is never picked up) and the command still exits 0. The
daemon drains that directory on its next sweep, so a signal sent during a
restart is delayed, not lost. `--no-spool` turns this off and exits 1 instead.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Accepted, spooled, or the waitpoint was already resolved |
| 1 | Refused (bad secret, unknown id, rate-limited) or unreachable with `--no-spool` |
| 2 | Usage error (missing id/secret, unknown flag, missing value, bad `--status` or `--exit-code`, unreadable `--data` file) |

An already-resolved waitpoint exits 0 on purpose: a retrying script should not
treat "someone already reported this" as a failure.

### Examples

```bash
# Report the exit code of the command that just ran
export CORTEX_SIGNAL_ID=wp_1a2b3c4d5e6f CORTEX_SIGNAL_SECRET=…
python train.py; cortex-signal --exit-code $?

# Report one arm of a multi-job waitpoint
cortex-signal --member arm2 --status ok --message "33,120 steps"

# Attach the tail of a log as data
python train.py; s=$?; tail -c 2000 train.log | cortex-signal --exit-code $s --data -

# Heartbeat without waking anyone
cortex-signal --status progress --message "epoch 12/40"

# Signal when a process that is already running exits
(while kill -0 12345 2>/dev/null; do sleep 5; done; cortex-signal --status ok) &
```
