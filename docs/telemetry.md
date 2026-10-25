# Telemetry

Cortex sends anonymous crash reports and usage statistics so that crashes get fixed and work goes
where it helps. Telemetry never contains your conversations, prompts, files, project names or
machine names. Each install is identified only by a random install ID. Telemetry is on by default.
`cortex init` and the desktop app's setup ask about it, and you can turn it off at any time in
**Settings → Privacy**.

This page lists everything that is sent, what is left out, and how to inspect, stop or delete it.
The wire format is defined in one file,
[`agent-server/src/domain/telemetry/schema.ts`](https://github.com/fangxm233/cortex-agent/blob/main/agent-server/src/domain/telemetry/schema.ts),
which the server, the collector and this page all follow.

## How it is sent

The server queues events in `<CORTEX_HOME>/data/telemetry/` and posts them in batches over HTTPS
to a collector run on Cloudflare Workers. Crashes go out within seconds. Other queued events go
out 30 seconds after the server starts, and every five minutes once it has been running for ten
minutes. The heartbeat goes out at most once every 24 hours, the first one about ten minutes after
the server starts. The day's usage rollup is sent once the UTC day has ended.

Uploads time out after ten seconds and never block or slow down your work. A failed upload is
retried with a backoff that starts at one minute and grows to six hours. A batch the collector
rejects is dropped.

Every batch starts with an envelope that describes the install:

| Field | Meaning |
|---|---|
| `installId` | Random UUID created once per install. The desktop app creates it during setup and passes it to the server it installs, so setup and later use share one ID |
| `version` | Cortex version |
| `channel` | `release`, or `dev` for a source checkout or debug build that has opted in |
| `installForm` | `desktop` (installed by the desktop app), `npm` (global npm install) or `other` |
| `os`, `osRelease`, `arch` | Operating system, its major release number only (such as `6` or `10`), and CPU architecture |
| `nodeMajor` | Node.js major version. Empty for steps the desktop app sends during setup |
| `uiLang` | Interface language: `en`, `zh` or `other` |
| `schema`, `sentAt` | Format version and send time |

The collector adds the two-letter country code that Cloudflare attaches to each request. It does
not store IP addresses.

## What is sent

### Crashes

A crash report is sent when the server, the daemon, the Web UI, or the desktop or Android app
crashes. The server records its own crashes, and the daemon's restart of a crashed server process
is recorded too. The Web UI reports render and window errors through the server. When the desktop
or Android app panics, it saves the panic and the Web UI forwards it through the server the next
time the app starts.

| Field | Meaning |
|---|---|
| `component` | `server`, `daemon`, `web`, `desktop` or `android` |
| `kind` | `uncaughtException`, `unhandledRejection`, `childExit` (the server process exited and the daemon restarted it), `renderError` and `windowError` (Web UI), or `panic` (desktop and Android app) |
| `errorName`, `message`, `stack` | Error type, plus the message and stack trace after [redaction](#how-text-is-redacted). Messages are cut to 300 characters and stacks to 30 frames |
| `groupKey` | Groups reports of the same crash: the error type plus the first frame in Cortex's own code (`TypeError@dist/domain/x.js#run`), the Web UI asset file, or the panic location (`panic@src/setup.rs:123`) |
| `uptimeS` | Seconds the process had been running |
| `route` | Web UI only: the route pattern, such as `/m/session/:sessionId`. A concrete path is never sent |
| `buildStamp` | Web UI build stamp or app version |
| `client` | Which app the Web UI ran in: `desktop`, `android` or `browser` |
| `exit` | Child exits only: exit code or signal, and the restart delay |
| `suppressed` | Reports of the same group that were held back by the rate limit |

Each crash group is sent at most once per hour, and each install sends at most 20 crash reports
per day.

### Errors that did not crash

Errors that Cortex logs without crashing are summarized in the daily rollup instead of being sent
one by one. `errors.byModule` counts the errors each internal logger module (such as `lifecycle`)
reported that day. `errors.samples` keeps up to five distinct errors, each with its module, a
group key, the redacted message and how many times it occurred.

### Daily heartbeat

The heartbeat describes how the install is set up:

| Field | Meaning |
|---|---|
| `backends` | Backends with working sign-in: `claude`, `pi` |
| `claudeBilling` | How Claude is paid for: `plan` (subscription), `api` or `none` |
| `piProviders` | PI providers with usable credentials, [normalized](#how-names-are-normalized) |
| `projects` | Number of projects |
| `onlineClients`, `clientPlatforms` | Number of connected remote machines, and a count of them by operating system |
| `activeSessions24h` | Number of sessions active in the last 24 hours |
| `uptimeH` | Hours the server has been running |
| `settings` | On or off for a fixed list of settings: `teamEnabled`, `serverAutoUpdate`, `serverUpdateDisable`, `autoResume`, `bgContinuation`, `streamDeltas`, `clientHotReloadEnabled`, `storeArchiveEnabled`, `providerUsageCollectionEnabled`, `claudeWindowWarmupEnabled`, `feishuSkillsInWeb`, `memoryIndexRegenEnabled` |

### Upgrades and migrations

Each server upgrade is reported with `from` and `to` versions, the `method` (`auto`, `prompt` or
`manual`), the `stage` and `durationS`. The stage is `installed` or `failed` for the npm step,
`confirmed` or `unconfirmed` depending on whether the next start runs the new version, or
`version-changed` when a start finds a different version and no recorded upgrade. A failure
includes a class (`network`, `permission`, `npm`, `disk`, `timeout` or `other`) and the redacted
message.

When one of the data migrations that run at startup fails, the report names the migration (its
version and the built-in file it changes, such as `2026.6.22:config/profiles.json`). It also
includes an error class (`io`, `parse`, `permission` or `other`) and the redacted message.

### Onboarding steps

Each onboarding step is sent once per install, so the reports show where new users get stuck. The
server reports these steps:

| Step | Detail |
|---|---|
| `server_init_completed` | — |
| `provider_authed` | The backend (`claude` or `pi`) of the first completed turn |
| `first_session`, `first_turn_completed` | — |
| `first_remote_client`, `first_worker`, `first_schedule` | — |

Before a server exists, nothing else can report how setup went, so the desktop app sends its own
setup steps directly to the collector. These steps are `setup_started`, `server_installed` or
`server_install_failed`, `init_completed` or `init_failed`, and `daemon_started` or
`daemon_start_failed`. A failed step includes only a class (`network`, `permission`, `disk`,
`timeout`, `cancelled` or `other`), never the error text.

### Daily usage rollup

One rollup per UTC day holds counts, never individual events. Durations and percentages are
reported as counts in fixed buckets (for example, turns that took up to 5 s, up to 15 s, and so on
up to more than an hour), never as individual values.

| Part | What it counts |
|---|---|
| Turn health | One row per backend, provider, model and billing type (up to 100 rows). Each row has completed, failed, cancelled and rate-limited turns; failure classes (`auth`, `rate_limit`, `network`, `adapter_crash`, `timeout`, `other`); retries; model fallbacks; time to first output for completed turns; turn duration; context use at the end of the turn; automatic and manual compactions; and input, output, cache-read and cache-write tokens. `customApi` gives the API type of a custom provider, such as `openai-completions` |
| Features | How often sessions were created, workers spawned, subagents run, boards opened, schedules created and fired, waitpoints created and signaled, and browser sessions used. Also how often plans were submitted, approved and rejected, questions were asked and answered, and remote machines connected |
| Tools | Calls and errors per [normalized](#how-names-are-normalized) tool name (up to 200 tools) |
| Entry points | Messages per channel (`desktop`, `android`, `browser`, `feishu`, `slack`, `tui`, `other`), and calls per Web UI operation (such as `sessions.send`) |
| Agent activity | Turns you interrupted, turns replaced by a newer message, a histogram of turns per session (session IDs are not sent), and completed, failed and cancelled worker and subagent runs |
| Performance | For each server start that day (up to ten), the time each startup phase took. Also event-loop lag (the median and maximum of the per-minute 99th percentile), Web UI load times (time to first byte, first render and interactive), live-update reconnects, and remote machine disconnects |
| Errors | The error summary described above |

## What is never sent

- Conversations, prompts, model output, or the contents of any file
- Commands, tool inputs or tool results
- File names, paths, project names, session titles or session IDs
- Machine names, hostnames, user names or email addresses
- IP addresses. The collector keeps only the country that Cloudflare derives from the request
- Names you made up: custom providers, custom models and third-party MCP tools are replaced as
  described below

## How names are normalized

Names that come from your configuration are checked against public lists before upload.

- **Providers and models.** The Claude backend is always reported as provider `anthropic`. Claude
  model names are kept when they appear in Cortex's built-in Anthropic model list or in the model
  catalog that ships with the PI SDK. PI providers and models are kept when they appear in that
  bundled catalog. A provider you define in `~/.pi/agent/models.json` is reported as `custom`
  along with its API type, and its models as `custom`. Everything else becomes `other`.
- **Tools.** The built-in tools of Claude Code and PI keep their names, as do Cortex's own MCP
  tools (`mcp__cortex-…`). Any other MCP tool becomes `mcp_other`, and any other tool becomes
  `other`.

Web UI operation names, logger module names, migration names and setting names come from
Cortex's own code. The local rollup file holds the raw names until the day is uploaded, and they
are normalized at that point.

## How text is redacted

Crash messages, stack traces and error samples are redacted before they are queued:

- Paths inside the Cortex installation become paths relative to it. Every other file path, on any
  platform, becomes `<path>`.
- URLs keep their scheme and path. The host becomes `<host>` (except loopback addresses), and the
  query string, fragment and credentials are removed.
- Email addresses become `<email>`. API keys, long hexadecimal or base64 strings and similar
  secrets become `<secret>`, and IPv4 addresses become `<ip>`.
- Your home directory, your machine's hostname and your user name become `<home>`, `<host>` and
  `<user>` wherever they still appear.

## When nothing is sent

The server records and sends nothing when any of these holds:

- Telemetry is turned off in **Settings → Privacy** (the `telemetryEnabled` setting).
- `CORTEX_TELEMETRY=0` is set in the server's environment or in `$CORTEX_HOME/config/.env`. It
  overrides the setting.
- `DO_NOT_TRACK` is set to any value other than empty, `0`, `false`, `no` or `off`.
- The server runs from a source checkout (its directory still has `src/`, or `CORTEX_REPO` is
  set). Setting `CORTEX_TELEMETRY=1` opts a checkout in, and its reports are marked `dev`.
- The Cortex home is sealed for benchmark runs (`CORTEX_CONFIG_IMMUTABLE=1`).
- The build has no collector address. Release builds contain one, and
  `CORTEX_TELEMETRY_ENDPOINT` overrides it. You can point it at your own HTTP endpoint to see
  exactly what would be posted.

While any of these holds, the server also deletes its queued events and daily counts. The
**Settings → Privacy** page tells you when one of these conditions, rather than the switch,
keeps telemetry off. The desktop app's setup steps follow the setup checkbox described below,
and `CORTEX_TELEMETRY=0` or `DO_NOT_TRACK` in the desktop app's environment stops them too.

## Inspecting what is queued

Everything waiting to be sent lives in `<CORTEX_HOME>/data/telemetry/` (`~/.cortex/data/telemetry/`
by default):

| File | Contents |
|---|---|
| `install-id` | The install ID |
| `outbox.jsonl` | Events waiting to be sent, one JSON object per line, exactly as they will be posted. Capped at 2 MB, with the oldest events dropped first |
| `outbox.sending.jsonl` | Events from an upload that is in progress or waiting to be retried |
| `rollup-YYYY-MM-DD.json` | Running counts for one UTC day, saved every five minutes and at shutdown. Unsent days older than seven days are dropped |
| `state.json` | Time of the last heartbeat, the last version seen, onboarding steps already sent, and an upgrade waiting to be confirmed |
| `crash-limits.json` | Crash rate-limit counters |

The desktop app keeps its own files in the `telemetry` folder of its app data directory:
`install-id`, `setup.json` (the setup checkbox and the setup steps already sent), and
`native-crash.json` (a panic waiting to be forwarded).

## Turning it off

- **Settings → Privacy** in the desktop app, the Android app or the browser workbench has a
  **Help improve Cortex** switch. Turning it off stops recording immediately and deletes the
  queued events and daily counts. The install ID stays, so you can still ask for your data to be
  deleted.
- `cortex init` asks whether to send anonymous statistics (the default is yes). Scripted
  installs set it with the `telemetry` field of the answers file:
  `{"telemetry": {"enabled": false}}`.
- The desktop app's setup screens have a **Help improve Cortex** checkbox, checked by default.
  It controls the setup steps from the moment you start the install, and it is passed to the new
  server as its telemetry setting.
- `"telemetryEnabled": false` in `$CORTEX_HOME/config/settings.json` is the same setting as the
  switch.
- `CORTEX_TELEMETRY=0` or `DO_NOT_TRACK=1` in the server's environment or in
  `$CORTEX_HOME/config/.env` turns telemetry off whatever the setting says.

## Retention and deletion

The collector deletes crash reports, error samples, upgrade reports and migration failures after
90 days. Daily rollups, heartbeats, onboarding steps and per-day activity records are kept for 13
months. An install's record is deleted 13 months after the install was last seen. The data is
readable only by the project's maintainers.

To have your data deleted, email [privacy@fangxm.me](mailto:privacy@fangxm.me) with your install
ID. You can copy the ID from **Settings → Privacy**. The ID is random and tied to nothing else, so
the email is the only thing that links it to you, and it is not kept after the deletion.

## Claude Code's own telemetry

When Cortex runs the Claude Code backend, Claude Code may send its own telemetry to Anthropic.
That telemetry follows Claude Code's settings and environment variables, not this switch.
