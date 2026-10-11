# CLI Reference

Cortex ships four binaries, registered in `agent-server/package.json`:

| Binary | Entry point | Purpose |
|---|---|---|
| `cortex` | `dist/entry/cortex-cli.js` | Server management and initialization |
| `cortex-evidence-export` | `dist/entry/production-evidence-export-cli.js` | Production benchmark evidence v2 export |
| `cortex-hook` | `dist/entry/hook-cli.js` | Hook inspection and blocking user asks |
| `cortex-signal` | `dist/entry/signal-cli.js` | Resolve a waitpoint from an external program |

All four accept `--help` (or `-h`) to print their usage.

---

## cortex

```
cortex <command> [options]
```

Server lifecycle and initialization CLI.

### Commands

**`cortex init [--home <path>] [--gateway-config-dir <path>] [--force] [--answers <file>] [--json]`**

Initialize `CORTEX_HOME`. The interactive wizard uses bundled PI by default
without a backend-selection prompt, collects platform (Slack / Feishu),
machine, usage-reporting, and service settings, writes `.env`, copies default
configs, and generates `mcp-config.json` and `agent-state.json`.

After writing configs, it detects local provider credentials and offers
login, rescan, continue with configured providers, or a warned skip. Login
uses the same flow as `cortex auth login`; choosing Claude Code reuses an
existing installation or asks permission to install a missing copy. Continue
configures gateway routes and profiles from detected endpoints. Detection
makes no paid inference request and does not verify model access.

`--answers` and `--json` runs do not start provider login or wait for input.
They report credential status and can finish with provider setup incomplete.

Options:
- `--home <path>` — set `CORTEX_HOME` (default: `$CORTEX_HOME` or `~/.cortex/`)
- `--gateway-config-dir <path>` — gateway config output directory (default: `~/.aistatus/`)
- `--force` — overwrite existing configs (`.env`, `budget.json`, `agent-state.json`, etc.)
- `--answers <file>` — read answers from a JSON document without prompting. Omitted fields use defaults; `{}` creates a single-machine installation using PI, with provider login still required if no credentials are detected. Used by the desktop installer. An explicit `backends` array retains its selection and installation semantics (`claude`, `pi`, or both); an explicit empty array retains the Claude fallback.
- `--json` — emit newline-delimited progress events on stdout and move human-readable output to stderr. The final event reports the home directory, the version, the client token, and the local Web UI URL.

**`cortex ui enable [--port <n>] [--home <path>] [--json]`**

Make this install reachable by the Cortex desktop app. Generates the client
token if it is missing, sets `CORTEX_UI_HTTP=1` and `CORTEX_UI_PORT`, and adds
the app's origins to `uiCorsOrigins`. Idempotent — running it twice changes
nothing the second time.

Restart the daemon when it reports that the configuration changed: `.env` is
read once at process start.

Options:
- `--port <n>` — the port to listen on (default: 3004)
- `--home <path>` — set `CORTEX_HOME`
- `--json` — print the endpoint, token, port, and whether anything changed as JSON

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

**`cortex start`**

Fork `dist/entry/app.js` as a child process, inherit stdio. This is the
primary way to run Cortex in the foreground. The child process runs the
Slack bot, webhook server, and all agent orchestration.

**`cortex daemon`**

Fork `dist/entry/daemon.js` as a child process, inherit stdio. The daemon
wraps `app.js` with file watching and auto-restart on crash. Touching
`$STORE_DIR/.restart` signals the daemon to drain and respawn `app.js`.

`cortex daemon stop` stops the daemon together with the client it launched on
this machine (the local client), so no Cortex process keeps running or keeps
files of the runtime in use. Clients on SSH and custom-command machines keep
running. The next `cortex daemon` launches the local client again.

**`cortex restart`**

Signal a running daemon to drain and respawn `app.js` by touching the
`.restart` trigger file at `$STORE_DIR/.restart`. If no daemon is running,
this is a no-op beyond creating the file.

**`cortex config`**

Print resolved paths and initialization status. Shows `INSTALL_ROOT`,
all data directories, and whether `.env`, `mcp-config.json`, and
`agent-state.json` exist.

**`cortex doctor [--fix] [--json]`**

Health-check the whole installation in one pass and report what is wrong.
The default run is read-only and safe at any time. It inspects four areas:

- Runtime & process — Node version, `git` on PATH, the configured backend
  binary (`claude` / `pi`), and whether the daemon is running.
- Backend install / login — data directories exist and are writable, `.env`
  is present, the WebSocket/webhook auth tokens are set, `ANTHROPIC_API_KEY`
  status, and that `agent-state.json`, `profiles.json`, and `mcp-config.json` are
  present and valid. It also smoke-tests the installed PI runtime and its
  `login` export, then summarizes expired or logged-out in-use providers from
  the credential-free backend auth snapshot. These two checks warn rather than
  fail. In API mode, a healthy gateway with no local key is reported as
  gateway-backed information instead of a false logged-out warning.
- Messaging platform — resolves `CORTEX_PLATFORM` and validates the
  credentials for each enabled platform (Slack `xoxb-`/signing/`xapp-`,
  Feishu app id/secret).
- Gateway — `~/.aistatus/gateway.yaml` presence and a health probe of
  `http://127.0.0.1:9880/status`. The probe is reported as a failure only
  when the gateway is actually in use; otherwise it is skipped.

Each check prints `[OK]`, `[WARN]`, `[FAIL]`, or `[--]` (skipped) with a
short detail and, for problems, a fix hint. The command exits `1` when any
check fails, else `0`.

Options:
- `--fix` — apply safe, idempotent repairs only: create missing data
  directories, generate missing auth tokens, and rebuild `mcp-config.json`.
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
synchronizes gateway/profile configuration and reports the sync result with
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
files, generate `~/.aistatus/gateway.yaml` (with backup of existing),
and write `$CORTEX_HOME/config/profiles.json`. Run this whenever you add
a new API key or change models.

Options:
- `--dry-run` — print the generated gateway.yaml to stdout without writing
- `--output-dir <path>` — write gateway.yaml and profiles.json under `<path>` instead of defaults

**`cortex schedule <list|get|add|edit|pause|resume|remove> [<id>] [options]`**

Manage scheduled tasks — the same records the MCP schedule tools, `!schedule`
and the Web UI manage. Each fire opens a new session in the schedule's project
and sends it the message; see [Scheduling](./scheduling.md). Changes are written
to `schedules.json`, and a running daemon picks them up within a second.

Every command prints JSON with `ok: true` and the schedule (`schedule`, or
`schedules` and `count` for `list`); timestamps are ISO 8601. Invalid input
exits 1 with the valid values on stderr.

- `list [--project <id>]` — all schedules, or one project's
- `get <id>` — one schedule; an unknown id exits 1
- `add --type <type> …` — create a schedule; prints `created: false` and the existing schedule when `--idempotency-key` matches one
- `edit <id> …` — change the message, project, profile, pre-check, or the timing fields of the schedule's type; the type itself is fixed
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
- `--profile <name>` — agent profile to run under (default: the default profile)
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

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (invalid command, missing config, runtime failure) |

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
stdin. The launcher owns every field: `outputDirectory`, `trialId`, `rootRunId`, `armName`,
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

## cortex-signal

```
cortex-signal [--id wp_…] [--secret …] [--status ok|fail|progress] [--message TEXT] [--exit-code N]
```

Tell Cortex that something it is waiting for has finished. The agent arms a
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
- `--data <@file|->` — extra payload from a file or stdin; it reaches the agent labelled as data, never as instructions
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
| 2 | Usage error (missing id/secret, unknown flag, bad `--status`) |

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
