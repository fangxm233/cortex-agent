# Backends

A backend is Cortex's adapter for a specific coding agent. Cortex does
not call LLM APIs directly. It drives a coding agent — Claude Code as a
child process, PI as a session inside the server process — sends
messages to it, and consumes a normalized event stream. Each backend
implements the `EngineAdapter` interface defined in
`agent-server/src/agent-adapter/types.ts`.

## Supported backends

| Backend | Status | Engine | Requirement | Feature level |
|---|---|---|---|---|
| Claude Code | Supported | `@anthropic-ai/claude-code` | the `claude` binary on `PATH` | Full |
| PI | Supported | `@earendil-works/pi-coding-agent`, installed with the server package | none beyond a logged-in provider | Full |

## How backends work

Three nouns cover the path from a message to a backend process: a **run**, a
**session**, and an **engine**.

A **run** is one execution of one user request: a conversation turn, a
hook-injected turn, an edit retry, an ask-user resume, or a subagent child.
`startRun` (`domain/runs/service.ts`) opens one from a fully resolved
`RunRequest` — engine selection, prompt, policy, and context — plus the observers that
watch it, and returns the `AgentRun` (`domain/runs/run.ts`) that owns the run's
event stream, its cancel and steer handles, and its result.

A **session** is the conversation identity a run continues: the stable Cortex
session id, the backend's own resume id, its engine selection, and the channel
it is bound to. A session owns the engine it resumes into. A run reuses its
session's pooled engine; a hook-injected turn gets an engine key, and an
engine, of its own.

The **engine** is the backend process itself — a pooled `claude` subprocess or
an in-process PI SDK session. `SessionEngines` (`domain/runs/engines.ts`) is
the only owner of pooled engines: `acquire(spec)` reuses the session for a
spec's engine key when it is alive and was opened from the same session
identity, and otherwise retires it and opens a new one. The adapter is
stateless; it opens a session from an `EngineSpec` and translates what that
session emits.

Configuration is resolved once per run. `resolveRunSelection`
(`domain/runs/config-resolver.ts`) uses an explicit complete selection, then the
session's recorded selection, the channel's selection, then `models.json`'s
`default`. The selection supplies backend, model, provider, gateway mode, and
thinking level. `buildEngineSpec` (`domain/runs/engine-spec.ts`) produces a
backend-neutral `EngineSpec`, which the adapter translates into Claude Code
command-line arguments or in-process PI session options. Each run uses one
engine selection.

From there the engine emits one `RunEvent` stream (`agent-adapter/run-events.ts`).
Each adapter translates its backend's native events into the `NormalizedEvent`
shapes declared in `agent-adapter/normalize/`, and `toRunEvent` tags them with
the run's phase, so the run layer never needs to know which backend is running.

**A run outlives its turn.** Claude opens a turn of its own when a background
task finishes, so a run has two endings and both are on the same stream. The
*foreground result* is the answer to the request: it lands as soon as the
backend finishes the turn, which is what `await run.result` gives a surface —
the reply is rendered and the status message can go into its waiting state
while the run is still alive. The *settled result* is the whole run with every
continuation folded in; it is what the terminal tally, the execution record and
the cost attribution read. A policy decides what happens after the foreground
result (`RunRequest.policy.background`): an interactive turn holds the session
open for the continuation (`hold`), and a run that cannot produce one, or
whose caller has no use for it, ends at the first result (`none`).

The wait itself is bounded, the work is not. `ContinuationPhase`
(`agent-adapter/continuation-phase.ts`) arms a grace timer for work the backend
reported finished but never announced (`CORTEX_BG_GRACE_S`, 90s) and a cap for
work still running (`CORTEX_BG_WAIT_MAX_S`, 30min); both defaults live in
`agent-adapter/bg-wait.ts`. The grace period expiring
ends the run; the cap expiring only ends the *waiting* — a tunnel or a monitor
that runs for an hour still streams its continuation into the same session when
it finishes.

## Feature matrix

Cortex defines four capabilities that a backend may support. The
orchestration layer checks capabilities before attempting backend-specific
operations.

| Capability | Claude Code | PI | Description |
|---|---|---|---|
| `mid-turn-inject` | yes | yes | Accept user input into a turn already in flight |
| `usage` | no | yes | Report scoped provider usage from a pull source or push cache |
| `background-continuation` | yes | no | Open a continuation turn of its own after the foreground result |
| `subagents` | yes | yes | Host a delegated subagent child, streamed and billed under its parent |

## Claude Code

The reference backend. Each session runs a persistent `claude -p` process
with stream-json input and output. Cortex pools the process by session key and
sends later turns over the same NDJSON stream until the session is closed,
times out, or its spawn identity changes.

Claude Code sessions are pooled by engine key for reuse (`SessionEngines`,
`domain/runs/engines.ts`). Each turn's cost is the growth of the CLI's own
cumulative `total_cost_usd`, measured from the total a resumed session starts
with (see [Cost reporting](#cost-reporting)).

Every `claude` process Cortex starts runs with
`CLAUDE_CONFIG_DIR=$CORTEX_HOME/data/claude`, Cortex's own Claude Code config
directory, so its transcripts, user settings, plugins and login stay apart from
a terminal `claude` using `~/.claude`. A pinned benchmark trial keeps the
config directory its own environment names. The directory, its one-time seed
from `~/.claude/settings.json`, and the plugin install command are described in
[Configuration → Claude Code config directory](./configuration.md#claude-code-config-directory).
The session-retention coordinator keeps that directory's `cleanupPeriodDays` equal
to the `sessionRetentionDays` runtime setting, preserving every other key.

## PI

PI runs inside the Cortex server process. The engine
(`@earendil-works/pi-coding-agent`) is bundled into the published server
package, so there is no separate `pi` command-line install and no PI process to
supervise. `agent-server/src/core/pi-sdk.ts` imports the SDK once per daemon —
on the first PI session or provider scan, since the entry pulls in every
provider client — and every PI session is created from that one handle.

**Sessions.** Each Cortex session runs on one PI SDK `AgentSession`.
`session-options.ts` resolves the spawn configuration into a session request,
and `runtime.ts` builds the session from it: a `SettingsManager` for the working
directory, a `ModelRuntime` reading `auth.json` and `models.json` from Cortex's
private PI agent directory, then `createAgentSessionServices` and
`createAgentSessionFromServices`. Sessions are pooled by session key and reused
across turns. A pooled session is retired when its spawn identity changes — a
different model, tool surface, or MCP set cannot be applied to a live session —
and when it goes idle or an explicit teardown closes it. `pi-session.ts` owns
the turn loop, mid-turn steering through the SDK's steer path, compaction, and
re-pointing a live session at another transcript. Resume names a session id or a
transcript path; `session-files.ts` maps the id to its file. Transcripts are
written under `$CORTEX_HOME/logs/sessions-pi/`.

**Mid-turn compaction.** A single Cortex turn is one whole PI agent loop, so a
long tool-driven turn must be able to compact from inside that loop. PI does this
itself: after the tool results land and before the next assistant response, it
compacts if the context has passed `contextWindow - reserveTokens`, then resumes
the same run, so the turn is never aborted and stays one Cortex turn. Cortex only
sets the threshold — `piCompactReserveTokens` (default 16384, PI's own default) is
mirrored into the private agent dir's `settings.json` when a session is created,
and a larger reserve makes PI compact earlier, leaving more working headroom.
Claude needs none of this: the CLI compacts inside a turn by itself.

**Context cap.** `maxContextTokens` caps the usable window of every model on both
backends. Claude receives it as `CLAUDE_CODE_AUTO_COMPACT_WINDOW`. On PI, Cortex
leaves the model's own window untouched, since PI also uses it to detect overflow,
and instead widens the reserve that `runtime-settings.ts` reports by the window's
excess over the cap. PI then compacts at `cap - piCompactReserveTokens`, with the
reserve bounded to half the cap so a large reserve cannot compact every turn.

**Cortex's glue.** Everything Cortex adds is a set of inline PI extensions
assembled per session in `extensions.ts`:

- **Image first** (`image-first.ts`) — moves the images in a tool result ahead
  of its text in each request.
- **MCP bridge** (`mcp-bridge.ts`) — serves the composition-scoped Cortex tool
  bundles in-process over an in-memory MCP transport pair, bound to a tool
  context built for that one session. Assigned plugin MCP servers keep their
  own stdio children or remote connections.
- **Tool shims** (`tool-shims.ts`) — registers the PI-local `web_fetch`,
  `web_search` and `todo_write` tools, each subject to the session's tool
  allowlist under its Claude name (`WebFetch`, `WebSearch`, `TodoWrite`), and
  the `agent` and `agent_stop` delegation tools where the session may delegate
  (see [Subagents](#subagents)).
- **Hook bridge** (`hook-bridge.ts`) — mounts the hook-registry entries that
  target the `pi` backend as native PI event handlers, so Cortex hook scripts
  see PI tool events. See [hooks.md](./hooks.md).
- **Quota probe** (`quota-probe.ts`) — reads provider quota off response headers
  on gateway-routed runs and hands each reading to the throttle.

System prompt override, appended prompts, and Cortex plugin skill directories
are session options (`systemPrompt`, `appendSystemPrompt`,
`additionalSkillPaths`), not command-line flags.

**Interaction tools.** User-initiated direct PI sessions add the interaction
bundle to their in-process Cortex tool set, so PI exposes the same
`cortex_ask_user`, `cortex_plan_enter`, and `cortex_plan_exit` tools as Claude
TUI and Claude print. Their dialogs travel over PI's extension UI protocol,
which `ui-context.ts` answers inside the server; see
[safety-and-approvals.md](./safety-and-approvals.md).

**Cache warming.** Cortex disables PI's automatic prompt-cache warming in both
main and subagent sessions. Ordinary provider prompt caching remains available;
Cortex does not issue extra warming requests whose usage is outside its cost
accounting. This is a runtime override and leaves the terminal PI settings intact.

**Credentials.** PI provider credentials are managed by Cortex — `!login pi` in
chat or **Settings → Accounts** on the web — and stored in PI's own auth file at
`~/.pi/agent/auth.json`. Cortex makes that file visible inside its private PI
agent directory (a symlink on Linux and macOS, a copy on Windows) so the SDK
reads it, and it reads user-defined providers from `~/.pi/agent/models.json`. An
installation that also has the terminal `pi` CLI therefore shares one set of
credentials and one provider catalog with Cortex.

PI transcript retention is filesystem-based. Active PI backend session ids are
protected during retention sweeps, while orphan transcript bundles under
`$CORTEX_HOME/logs/sessions-pi/` are deleted only after they stay unreferenced
past the retention cutoff and survive a second confirmation sweep.

PI provider names are independent of Cortex backend names. In particular,
`openai-codex` is a supported PI provider (including the
`openai-codex-responses` API kind); engine selections using it set
`"backend": "pi"`.

## Subagents

Both backends delegate through one tool, one role table, and one runner, and
either backend can be the parent or the child. A Claude turn can hand work to a
PI model and a PI turn can hand work to Claude.

**The tool.** PI registers `agent` and `agent_stop` in-process. Claude gets the
same pair as MCP tools (`mcp__cortex-core__agent`, `mcp__cortex-core__agent_stop`)
and its own built-in `Agent` tool is stripped from every spawn, so there is no
second delegation path the daemon cannot see. One call runs a single task, up to
eight in parallel, or up to eight chained; `{previous}` in a chained prompt is
replaced with the previous link's output.

**Roles.** A role is a markdown file with YAML frontmatter. `explore`,
`general-purpose`, and `plan` are built in and read from the install's
`agent-server/defaults/agents/`; a file in `$CORTEX_HOME/config/agents/` adds a
role, or replaces the built-in role of the same name, and deleting it brings the
built-in one back. The role body is appended to the child's system prompt. Its
frontmatter must set `name` and `description` — a file without them is
ignored — and may set:

| Key | Meaning |
|---|---|
| `tools` | Canonical tool names, translated into each backend's own spelling |
| `model` | `provider/model[:thinking]` for a PI child, a bare model id for a Claude child |
| `backend` | `claude` or `pi`; absent means "whatever the parent is running" |
| `mode` | PI child route: role value, then the PI parent’s route on the same provider, then the provider name. Claude children use their Claude parent’s route or the configured Claude-backend default route |

When `$CORTEX_HOME/config/agents/` does not exist yet, roles found in an
`agents/` directory inside Cortex's private PI agent directory are moved into
it at startup, and that directory is renamed to `agents.migrated` so an edit
there cannot silently do nothing.

**Choosing the model.** The model is the task's
explicit `model` when given, then the role's `model`, then the parent's own
model — but only when the child runs the same backend, since a Claude model id
means nothing to PI and a PI `provider/model` means nothing to Claude. A Claude
child without an explicit or same-backend parent model uses the Claude-backend
default (the configured default if Claude, otherwise the first Claude favorite).
A PI parent starting a Claude child also uses that Claude default’s route and
requires a Claude default or favorite to be configured.

**What the caller can see.** The `subagent_type`, `model`, and `backend` field
descriptions are rendered at tool-registration time rather than hardcoded, from
what this host actually has. Roles come from the live role table — the built-in
roles with `$CORTEX_HOME/config/agents/` laid over them — so a role you add shows
up in the next session. Claude model ids come from the same table Cortex builds the gateway's
Anthropic routes from, plus the daemon's current model. A PI parent reads its
own live model registry; a Claude parent cannot, because its MCP tool runs in a
sidecar process that has no PI SDK, so the daemon passes down the provider/model
pairs of its cached scan through the spawn environment. A cold cache simply
means no PI models are listed yet — the scan is never provoked just to decorate
a Claude spawn. Roles and
models each have a character budget, and overflow renders as `(+N more)`. The
lists are a snapshot, so they do not change mid-session, and they are hints
rather than a whitelist: an unlisted model id is still accepted and passed
through. When nothing is known, the descriptions fall back to the generic
wording, so the tool never fails over a missing catalog.

**Isolation.** A `pi` child is a nested in-process session that writes no
transcript and runs headless. A `claude` child is a frozen one-shot `claude`
run: no session to resume, no hooks, no ambient rules, no transcript log. Either
way the child's MCP surface is the `cortex-core` bundle with the delegation
tools removed, so it cannot fan out further.

**Clean children.** A task with `clean: true` runs in a fresh
`$CORTEX_HOME/workspaces/sub-<run>-<index>/` folder under the rules of a
[clean session](./configuration.md#clean-mode): no `AGENTS.md` from that folder
or its ancestors, and the workspace section after its role prompt. `files` lists
files or directories — absolute, `~`-relative, or relative to the parent's
working directory — that are copied into the child's `inputs/` before it starts.
Listing any implies `clean`, and a path that does not exist rejects the whole
call before any child starts. Every child of a clean session is clean and works
in that session's own workspace, its `files` copied into the same `inputs/`. A
clean child's brief has to stand on its own: it names the given files as
`inputs/<name>`. It may include external paths only when the user explicitly
authorizes access, and must state the allowed operations. Its result ends with
`Workspace: <path>`, the folder where it leaves its output, and its block in the
transcript is marked clean.

**What the parent sees.** A child's tool calls, results, and text are streamed
into the parent's live transcript attributed to the subagent, and its token
usage is rolled into the parent's. Attribution is best-effort: a run whose
parent turn has already ended simply stops streaming and still returns its
answer.

**Background runs.** `run_in_background: true` returns an `agent_id`
immediately. Cortex holds the session open for the length of the run — the Stop
button reaches it, and a deferred daemon restart waits for it — and delivers the
answer as an ordinary turn when it is ready, folding into a live turn if one is
running. `agent_stop` cancels a run early and discards what it had produced.
Stopping a session stops its delegated runs too, foreground and background
alike: children never outlive the turn that asked for them.

## Remote login

Backend login can be completed remotely without SSH access to the Cortex
host. The same login flow is exposed through three channels:

| Channel | Entry | Interaction |
|---|---|---|
| Slack | Send `!login`, `!login cc`, or `!login pi [provider]` | Selectors and secret fields open in Slack modals; authorization links are posted to the channel. |
| Feishu | Send `!login`, `!login cc`, or `!login pi [provider]` | Selectors and secret fields use inline card forms; authorization links are posted to the chat. |
| Web (desktop and mobile) | Desktop: open **Settings → Accounts**. Mobile: tap **Settings → Accounts** to drill in to `/m/settings/accounts`. | The Accounts section shows Claude Code credentials and every PI provider, with status plus login/logout actions that open the same selector-driven login flow. |

The chat command forms are:

```text
!login
!login status
!login cc
!login pi
!login pi <provider>
!login custom
```

`!login custom` manages self-hosted endpoints that have no login flow; see
[Custom providers](#custom-providers) below.

`!login` with no arguments and `!login status` both show the authentication
status overview. `!login cc` selects Claude Code. `!login pi` opens a PI
provider selector; adding a provider skips that selector. Authentication type
is also selected interactively when a provider supports more than one type.
Do not append `oauth`, API keys, authorization codes, or provider-specific
OAuth flags to the command.

One backend/provider pair has at most one login in progress. Starting a login
cancels an unfinished one for the same pair, whichever channel started it,
unless that login is already saving a submitted credential; then the new start
is refused until it finishes. A failed login shows Cortex's message followed by
the first line of the provider's own reason.

OAuth is offered only when the installed PI provider exposes
`provider.auth.oauth.login` as a function. The list is discovered from the
installed PI runtime, so API-key-only providers never show a non-functional
OAuth option. Claude Code
similarly offers API-key and subscription choices through the selector.

For a Claude Code subscription, Cortex starts `claude auth login --claudeai`
against its own Claude config directory, sends the command's authorization URL
to the initiating channel, and writes the returned code to that command's
standard input. Claude Code owns the OAuth
exchange and credential persistence. Cortex marks the flow complete only after
an authentication-environment-scrubbed `claude auth status --json` reports
`loggedIn: true`; it never reads or stores the resulting token. Subscription
logout similarly delegates to `claude auth logout` and verifies the logged-out
postcondition. A legacy Cortex-managed subscription token remains a removable
runtime credential while Claude Code is logged out, but it does not make the
account appear logged in and is suppressed as soon as Claude owns a credential.

When a running backend reports expired authentication, Cortex posts a card that
names the provider and offers one-click re-login, pre-filled with the
authentication type that failed: for Claude Code, the API key when the run used
`api` mode and the subscription otherwise. While that login runs, the button
reopens it; after it fails, is cancelled or expires, the button starts a new
one. A daily expiration scan checks in-use accounts and sends the same
actionable warning for credentials that are expiring, expired, or missing. The
daily scan skips any provider the runtime notification already reported within
the reminder window, so a scheduled warning never repeats a notice you just
received. The reverse is deliberate: a runtime failure always notifies, even if
the daily scan warned about that provider earlier, because an in-session failure
is the message you most need at that moment.

For a read-only status check from the host, use:

```bash
cortex auth status
cortex auth status --json
```

The text form is a concise overview; `--json` returns the complete normalized
status snapshot. Both are credential-free. See
[CLI Reference](./cli-reference.md#cortex) for the exact command contract.

## Custom providers

A custom provider is an endpoint PI does not ship a definition for: a local
inference server, a lab GPU box, or a company proxy. It has no login flow —
there is no vendor to authenticate against — so it is defined rather than
logged into, and it is managed from the same three surfaces as everything else:

| Surface | Entry |
|---|---|
| CLI | `cortex auth provider list \| add \| remove` |
| Web (desktop and mobile) | **Settings → Accounts → Custom providers** |
| Slack / Feishu | `!login custom [list \| add <name> <api> <url> <model…> \| remove <name>]` |

A definition needs four things: a name, the request protocol the endpoint
speaks (`anthropic-messages`, `openai-completions`, `openai-responses`, or
`google-generative-ai`), the upstream URL, and at least one model id. An
upstream key is optional; without one the gateway passes the caller's own key
through.

Saving writes two files. `~/.pi/agent/models.json` gets a `providers.<name>`
entry whose `baseUrl` points at the gateway, so the terminal `pi` and Cortex
share one definition. `~/.aistatus/gateway.yaml` gets the route that forwards to
the real endpoint, carrying the upstream key. **The key lives only in the
gateway config** — the PI catalog holds a placeholder, so copying the catalog
around never copies a secret. Every call therefore goes through the gateway and
is accounted and throttled like any other route. The generated gateway config
sets `max_body_size_mb: 100`. With aistatus 0.0.8 or newer, this caps each
buffered request body in MiB; edit the top-level value to use a different limit.
The gateway reloads its config by itself, so route and body-limit changes need
no restart.

The chat command deliberately has no key argument: a channel transcript is a
poor place for a secret. Add the key from the CLI with `--key -` (read from
stdin) or from the Web form, both of which keep it off any transcript.

To use a custom provider, choose its model in the picker or enter
`!model my-vllm/Model-27B`. You can favorite it and make it the default (see
[configuration.md](./configuration.md#modelsjson)). Deleting a provider removes
its catalog entry and gateway route; first move sessions, the default,
favorites, and schedules using it to another provider.

## Selecting a backend

Each session stores a concrete engine selection: `backend`, `provider`, `model`,
`thinking`, and `mode`. `backend` is `claude` or `pi`; Claude uses a null provider,
while PI requires a provider id that selects its request protocol and gateway
endpoint. The default selection and favorites live in
[`config/models.json`](./configuration.md#modelsjson).

`!backend <claude|pi>` selects the configured default if it belongs to the target
backend, otherwise the first favorite on that backend with its remembered
settings. If neither exists, favorite a model there first. A conversation with
history cannot change backend; start a new session for that.

## Per-session model, thinking level and route

The Web and mobile composer's engine picker lists favorite models at its root,
showing each model and its remembered thinking level, grouped by backend and
provider. Open the full model list to choose another model or use a row's star
to add or remove a favorite. The thinking picker includes a default option,
which stores `null` and lets the backend choose. `/model` opens model selection.
The execution environment is a separate choice; see
[configuration.md](./configuration.md#choosing-an-environment-per-conversation).

A selection is saved on the session. Choosing a model restores that model's
remembered thinking and route; without a memory, thinking is null, Claude uses
the first Anthropic route in `gateway.yaml` (`plan` if none is declared), and PI
uses its provider name. User changes update the model's memory. A fresh Web
conversation starts from the last selected engine on this host.

A conversation with history cannot change backend. The picker disables models
on the other backend; a new draft can choose either backend.

**Route** is the gateway endpoint's billing lane: for example, `plan` for an
Anthropic subscription or `api` for a metered key. The picker offers routes
declared for the endpoint in `gateway.yaml`, and hides the route choice when
only one is available. The model catalog supplies each endpoint's backend,
provider, routes, and models. Thinking levels use the backend's range, narrowed
to the model's own levels where PI reports them.

**Settings → Models** manages the default model and the favorites list. Platform
channels use the same selection rules through these commands:

| Command | What it does |
|---|---|
| `!model` | Shows the current selection and favorites, with favorite buttons |
| `!model <id>` | Selects a model on the current backend |
| `!model <provider/model>` | Selects a PI model with an explicit provider |
| `!model reset` | Restores the complete configured default selection |
| `!thinking [level]` | Shows or sets the reasoning level |
| `!thinking reset` | Sets thinking to null, using the backend default |
| `!mode [route]` | Shows or sets the gateway route, validated against the endpoint's routes |

## Thinking level

`thinking` sets reasoning depth in the backend's native value set. Claude Code
accepts `low`/`medium`/`high`/`xhigh`/`max`, passed as `--effort`. PI accepts
`off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`, passed as the session's thinking level.
A null value uses the backend's own default. A level the selected model does not
accept is clamped by PI to the nearest one it does.

## Usage-limit throttling and auto-resume

Cortex tracks rolling usage windows by provider. Provider identifiers are opaque strings, so
the throttle can track any number of providers without a fixed provider
enum. Each provider keeps its own window types and reset times. A provider
and route mode are gated without blocking another provider that happens to
use the same mode name.

The policy is configured in [`config/settings.json`](./configuration.md#configsettingsjson)
as `providerRateLimits`, an object keyed by provider id. Each provider can
hold a `windows` array of `{ type, label?, enabled, threshold? }` entries, so
5-hour, weekly, weekly-overage, Codex primary/secondary, and labeled model
windows are independently configurable. `threshold` is a ratio greater than
`0` and at most `1`; an omitted value uses `0.95` for the weekly windows
(`seven_day`, `seven_day_overage_included`) and `0.90` for every other window,
`five_hour` included. Exact window policy takes precedence over the visible,
clearable legacy provider fallback. Desktop and mobile Usage edit these rows;
spend-only providers do not show quota controls.

### Why a rate-limit signal is injected, not streamed

The adapter reports a provider's rate-limit window to the host through an
injected callback (`RateLimitReporter`), not as a `RunEvent`. The backend emits
its `rate_limit_event` between turns and during a spontaneous continuation turn,
i.e. exactly when no turn is in flight — routing it through the per-turn event
stream would drop the observation that matters most. `RunEvent` therefore carries
`rate_limit` only as a transcript-level notice (`agent-runner` ignores it), and
the throttle itself is fed by the injected reporter. Quota observations take the
same path.

Interrupted conversations are stored with the provider that limited them.
When one provider fully recovers, Cortex resumes only that provider's work;
entries belonging to other active providers remain queued. A conversation
resumes in its own channel with the prior context intact. Resume starts are
staggered so a freshly opened window is not immediately exhausted.

The active rate-limit details show the number of waiting conversations for
each provider and preserve labels for simultaneous model-scoped
windows. The provider key is the isolation boundary: multiple accounts or
quota pools reported under the same provider key share one provider record,
and windows with the same type and label retain the later reset time. Timed
throttling requires a reset-bearing observation. Claude live account-usage
pulls submit every reported window for each configured Anthropic mode, while
stale PI cache reads are never replayed; PI response-header observations
arrive through their push path, and the OpenAI Codex and Claude account reads
of each usage collection are described
[below](#account-usage-and-banked-resets).

Policy edits apply only to future quota observations. They do not rewrite a
window that is already active. An active quota window or outage retry window
stays in force until its reset time or a manual **Resume now** clear; a Codex
or Claude quota window also lifts when a fresh account reading shows it below
its threshold. Outage
retry behavior uses its own outage windows and is unaffected by quota-policy
threshold edits.

Throttle windows and provider-attributed resume entries persist in
`data/provider-state.json`. On startup Cortex re-arms active timers and
immediately resumes entries whose provider window expired during downtime,
even when a different provider remains limited. Provider-less entries from
older data wait until every active provider clears. A channel that already
has an active conversation is skipped; elapsed age alone does not discard
work.

Auto-resume is on by default. Set `"autoResume": false` in
[`config/settings.json`](./configuration.md#configsettingsjson) to drop ready
resume entries instead of dispatching them automatically; the change takes
effect without a daemon restart. The legacy `CORTEX_AUTO_RESUME=0` variable in
`.env` is still read as a deprecated fallback.

### Account usage and banked resets

Every usage collection — the built-in provider-usage job, opening a Usage
screen, or **Refresh** — reads two subscription accounts directly:

- **OpenAI Codex**, with a ChatGPT-plan sign-in. The reading fills the Codex
  primary and secondary windows on the Codex subscription row. When the read
  fails, the row keeps the windows last observed in Codex response headers and
  carries a note saying so.
- **Claude**, signed in with `claude login`. The reading fills the five-hour
  and seven-day windows on the Anthropic subscription row, plus the weekly
  limit the account scopes to one model, shown with that model's name, such
  as **7 days (Fable)**. That model window is the one Claude Code reports as
  `seven_day_overage_included`, so its threshold control is the policy that
  window's throttle uses. Cortex uses the
  access token Claude Code stores and cannot refresh it, so with an expired
  token, an API-key setup, or no login the row falls back to the gateway's
  quota observation; a failed read falls back the same way and adds a note.
  The account offers resets only to a current Claude Code client, so these
  requests identify as the installed `claude` CLI version.

Each reading also lists the account's banked resets: how many are available
and when the earliest one expires. An account reading never starts a
throttle, but it lifts that provider's throttle windows that have fallen below
their threshold, so a reset spent from another device also releases work
Cortex paused.

A banked reset applies to the whole account, on every device, and cannot be
undone. A Codex reset restores the Codex usage windows and expires about 30
days after it is granted. A Claude reset clears the windows its grant names —
typically the five-hour, seven-day, and seven-day-including-overage limits —
for claude.ai and every other Claude client as well. Cortex never spends a
reset on its own. On the Codex and Anthropic cards in desktop and mobile
Usage, **Reset** appears while a reset is available and asks for
confirmation first; the Claude confirmation names the windows the reset
clears and, while the account is not at a limit, shows their current use.
Cortex spends the reset the account offers next, otherwise the one that
expires first. In chat, `!usage` shows the same count and expiry with a
**Reset Codex** or **Reset Claude** button that posts a confirm prompt
in the thread, and a Codex or Claude throttle notice carries that button next
to **Resume now** while the account holds a reset. After a reset Cortex clears
that provider's throttle, resumes the work it paused, and re-reads usage for a
few seconds until the account shows the cleared windows restored. When the
account declines — nothing to reset, a reset already used, a cooldown, or an
account that cannot use resets right now — no reset is spent and Cortex says
which case applies.

## Cost reporting

Cost reporting differs by backend:

- **Claude Code** — reads the cumulative `total_cost_usd` the CLI reports at
  the end of each turn and records the increase since the previous turn, with
  the token counts from the same result. A resumed session starts from the total
  the CLI restores, so its history is not billed again. Records are written to
  `$CORTEX_HOME/data/costs.jsonl`.
- **PI** — reads the usage the session reports on each assistant message
  (`input`, `output`, `cacheRead`, `cacheWrite`, and `cost.total`) and sums
  it per turn into one record naming the provider and model that served it.
  A token field the provider does not report is recorded as unknown rather
  than as zero. Records land in the same `$CORTEX_HOME/data/costs.jsonl`.

All cost records follow the same JSONL format and are subject to a 90-day
rolling retention window. Cost queries via MCP tools aggregate across all
backends — see [mcp.md](./mcp.md) for the `cost_query` tool.

## Adding a new backend

New backends implement the `EngineAdapter` interface in a new directory under
`agent-server/src/agent-adapter/`. The required surface:

1. **`adapter.ts`** — implements `EngineAdapter` with `open(spec)`, returning an
   `EngineSession`. The adapter is stateless: `SessionEngines` owns the pool.
2. **`EngineSession`** — carries its `backend`, `identity` and
   `backendSessionId`, and exposes `run(prompt, opts)` for one turn, returning
   an `EngineRun` whose `events` is an async iterable of `RunEvent`, whose
   `result` is the foreground `AgentResult` and whose settled result folds in
   any continuation, with `cancel()`; plus `steer()`, `respondToDialog()`,
   `ingestExternal()`, `compact()`, `close()`, and `kill()`.
3. **Event translation** — turns the backend's native event format into
   `NormalizedEvent` / `RunEvent` members (for Claude, `event-parser.ts` and
   `event-translator.ts`).
4. **Registration** — add the adapter to the assembly in
   `domain/runs/adapters.ts` and a branch to `SessionEngines.acquire` in
   `domain/runs/engines.ts`; add capabilities to `capabilities.ts`; include the
   backend label in the `Backend` type union in `core/types/agent-types.ts`. A
   backend that hosts subagents also needs a branch in
   `domain/agents/subagent/runner.ts`.

Shared pieces live beside the adapters: the normalized event types, prompt
building and tool-result image handling in `agent-adapter/normalize/`, the
`RunEvent` queue in `agent-adapter/run-events.ts`, and tool-name translation
in `core/tool-names.ts`.
