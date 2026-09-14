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
| Claude Code | Supported | `@anthropic-ai/claude-code` | the `claude` binary on `PATH` | Full (11/11 capabilities) |
| PI | Supported | `@earendil-works/pi-coding-agent`, bundled inside the server package | none beyond a logged-in provider | Full (11/11 capabilities) |

## How backends work

Three nouns cover the path from a message to a backend process: a **run**, a
**session**, and an **engine**.

A **run** is one execution of one user request: a conversation turn, a thread
step, a hook agent, an edit retry, an ask-user resume, or a subagent child.
`startRun` (`domain/runs/service.ts`) opens one from a fully resolved
`RunRequest` — profile, prompt, policy, and context, with no callbacks — and
returns the `AgentRun` (`domain/runs/run.ts`) that owns the run's event stream,
its cancel and steer handles, its fallback chain, and its result.

A **session** is the conversation identity a run continues: the stable Cortex
session id, the backend's own resume id, the profile it runs, and the channel
it is bound to. A session owns the engine it resumes into. A run reuses its
session's pooled engine; separate engine keys (a thread step's slot, a
hook-injected turn) get their own.

The **engine** is the backend process itself — a pooled `claude` subprocess or
an in-process PI SDK session. `SessionEngines` (`domain/runs/engines.ts`) is
the only owner of pooled engines: `acquire(spec)` reuses the session for a
spec's engine key when it is alive and was opened from the same session
identity, and otherwise retires it and opens a new one. The adapter is
stateless; it opens a session from an `EngineSpec` and translates what that
session emits.

Configuration is resolved once per run. `resolveRunConfig`
(`domain/runs/config-resolver.ts`) picks the profile by priority — an explicit
override, the session's recorded profile, the channel's profile, the active
profile, then `profiles.json`'s `defaultProfile` — and the profile supplies the
backend, model, provider, gateway mode, thinking level, and fallback chain.
`buildEngineSpec` (`domain/runs/engine-spec.ts`) turns the resolved run into a
backend-neutral `EngineSpec`, which the adapter translates into backend-native
form: command-line arguments for the Claude Code child process, session options
for the in-process PI session.

From there the engine emits one `RunEvent` stream (`domain/runs/events.ts`).
The normalization layer (`agent-adapter/normalize/`) translates each backend's
native event format into `NormalizedEvent`, and `toRunEvent` tags it with the
run's phase, so the run layer never needs to know which backend is running.

**A run outlives its turn.** Claude opens a turn of its own when a background
task finishes, so a run has two endings and both are on the same stream. The
*foreground result* is the answer to the request: it lands as soon as the
backend finishes the turn, which is what `await run.result` gives a surface —
the reply is rendered and the status message can go into its waiting state
while the run is still alive. The *settled result* is the whole run with every
continuation folded in; it is what the terminal tally, the execution record and
the cost attribution read. A policy picks which one the caller waits for
(`RunRequest.policy.background`): an interactive turn holds (`hold`), a thread
step or dispatched job waits for the merged result (`inline`), and a run that
cannot produce a continuation ends at the first result (`none`).

The wait itself is bounded, the work is not. `ContinuationPhase`
(`agent-adapter/continuation-phase.ts`) arms a grace timer for work the backend
reported finished but never announced (`CORTEX_BG_GRACE_S`, 90s) and a cap for
work still running (`CORTEX_BG_WAIT_MAX_S`, 30min). The grace period expiring
ends the run; the cap expiring only ends the *waiting* — a tunnel or a monitor
that runs for an hour still streams its continuation into the same session when
it finishes.

## Feature matrix

Cortex defines eleven capabilities that a backend may support. The
orchestration layer checks capabilities before attempting backend-specific
operations.

| Capability | Claude Code | PI | Description |
|---|---|---|---|
| `hooks` | yes | yes | PreToolUse/PostToolUse/Stop hooks via hook-bridge |
| `plugins` | yes | yes | Role-scoped skill plugins |
| `mcp` | yes | yes | MCP tool server integration |
| `plan-mode` | yes | yes | EnterPlanMode/ExitPlanMode tool support |
| `ask-user-question` | yes | yes | AskUserQuestion tool support |
| `system-prompt-override` | yes | yes | Custom system prompt injection |
| `session-resume` | yes | yes | Resume an existing session |
| `tool-allowlist` | yes | yes | Restrict available tools to a subset |
| `streaming-deltas` | yes | yes | Publish token-level assistant text during generation |
| `mid-turn-inject` | yes | yes | Accept user input into a turn already in flight |
| `subagents` | yes | yes | Host a delegated subagent child, streamed and billed under its parent |

## Claude Code

The reference backend. Supports all eleven capabilities. Two
adapter modes are defined; TUI is deprecated:

**Print mode** (`claudeBackend: "print"`, default). Uses a persistent
`claude -p` process with stream-json input and output. Cortex pools the process
by session key and sends later turns over the same NDJSON stream until the
session is closed, times out, or its spawn identity changes.

**TUI mode** (`claudeBackend: "tui"`, deprecated). Historically spawned an
interactive Claude session under tmux and tailed the session's JSONL file for
events. D9 deprecated it: the adapter warns once and runs the session in print
mode instead.

Claude Code sessions are pooled by engine key for reuse (`SessionEngines`,
`domain/runs/engines.ts`). Cost reporting reverse-derives USD from
`message.usage` token counts using Anthropic's published pricing.

The session-retention coordinator also syncs Claude's user-level
`cleanupPeriodDays` into `$CLAUDE_CONFIG_DIR/settings.json` (or
`~/.claude/settings.json`) using the same `sessionRetentionDays` value from
Cortex runtime settings. That write is a merge into the user settings file only:
it preserves every other Claude key, does not touch project-local
`.claude/settings.local.json` or `.claude/settings.json` files in the spawn cwd,
and does not take ownership of hook/permission configuration outside that one
helper key. If the user file already has the same `cleanupPeriodDays`, nothing is
rewritten.

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

**Mid-turn compaction.** PI tests its compaction threshold only between turns —
after its agent loop ends, before a new prompt, and on a context-overflow error —
so one long tool-driven Cortex turn has no check at all inside it. `context-guard.ts`
adds one: it wraps the session's own per-turn hook, and once context occupancy
crosses `piMidTurnCompactPercent` (default 88, `0` disables) it runs PI's own
compaction at the next tool-batch boundary and hands the loop the rebuilt context.
Nothing is aborted, so the turn keeps running and stays a single Cortex turn.
Claude needs none of this: the CLI compacts inside a turn by itself.

**Cortex's glue.** Everything Cortex adds is a set of inline PI extensions
assembled per session in `extensions.ts`:

- **MCP bridge** (`mcp-bridge.ts`) — serves the composition-scoped Cortex tool
  bundles in-process over an in-memory MCP transport pair, bound to a tool
  context built for that one session. Assigned plugin MCP servers and browser
  MCP keep their own stdio children or remote connections.
- **Tool shims** (`tool-shims.ts`) — registers the PI-local `agent`,
  `agent_stop`, `TodoWrite`, `WebFetch`, and `WebSearch` tools, each subject to
  the session's tool allowlist.
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
`openai-codex-responses` API kind); profiles using it still set
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

**Roles.** A role is a markdown file with YAML frontmatter in
`$CORTEX_HOME/config/agents/`. `explore`, `general-purpose`, and `plan` ship as
defaults and are copied in only if missing, so an edited role always survives an
upgrade. The role body is appended to the child's system prompt. Its frontmatter
may set:

| Key | Meaning |
|---|---|
| `tools` | Canonical tool names, translated into each backend's own spelling |
| `model` | `provider/model[:thinking]` for a PI child, a bare model id for a Claude child |
| `backend` | `claude` or `pi`; absent means "whatever the parent is running" |
| `mode` | Explicit gateway route for the child; absent falls back to the provider name |

An installation that used PI subagents before unification has its old
`pi/agents/` directory adopted into the shared table the first time it starts,
and the old directory is renamed to `pi/agents.migrated` so an edit there cannot
silently do nothing.

**Choosing the model.** No profile is consulted. The model is the task's
explicit `model` when given, then the role's `model`, then the parent's own
model — but only when the child runs the same backend, since a Claude model id
means nothing to PI and a PI `provider/model` means nothing to Claude.

**What the caller can see.** The `subagent_type`, `model`, and `backend` field
descriptions are rendered at tool-registration time rather than hardcoded, from
what this host actually has. Roles come from the live
`$CORTEX_HOME/config/agents/` table, so a role you add shows up in the next
session. Claude model ids come from the same table Cortex builds the gateway's
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
tools removed, so it can neither fan out further nor reach thread control.

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

OAuth is offered only when the installed PI provider exposes
`provider.auth.oauth.login` as a function. On the reference installation this
criterion was true for 7 of 39 providers; the list is discovered dynamically,
so API-key-only providers never show a non-functional OAuth option. Claude Code
similarly offers API-key and subscription choices through the selector.

For a Claude Code subscription, Cortex starts `claude auth login --claudeai`,
sends the command's authorization URL to the initiating channel, and writes the
returned code to that command's standard input. Claude Code owns the OAuth
exchange and credential persistence. Cortex marks the flow complete only after
an authentication-environment-scrubbed `claude auth status --json` reports
`loggedIn: true`; it never reads or stores the resulting token. Subscription
logout similarly delegates to `claude auth logout` and verifies the logged-out
postcondition. A legacy Cortex-managed subscription token remains a removable
runtime credential while Claude Code is logged out, but it does not make the
account appear logged in and is suppressed as soon as Claude owns a credential.

When a running backend reports expired authentication, Cortex posts a card that
names the backend/provider and offers one-click re-login with the selection
pre-filled. A daily expiration scan checks in-use accounts and sends the same
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

To use a custom provider, add a profile that names it — for example
`{"backend": "pi", "provider": "my-vllm", "mode": "my-vllm", "model": "Model-27B"}`
(see [configuration.md](./configuration.md) for the profiles schema). Deleting
a provider removes both the catalog entry and the gateway route; profiles that
still point at it will fail to resolve, so re-point them first.

## Selecting a backend

Backends are selected per profile in `$CORTEX_HOME/config/profiles.json`
(see [configuration.md](./configuration.md) for the full profiles schema):

```json
{
  "defaultProfile": "plan",
  "profiles": {
    "plan": {
      "model": "claude-sonnet-4-20250514",
      "backend": "claude"
    },
    "execute": {
      "model": "claude-sonnet-4-20250514",
      "backend": "pi"
    }
  }
}
```

The `backend` field accepts `"claude"` or `"pi"`. If omitted, it defaults
to `"claude"`.

Thread templates can also specify a profile per agent, allowing different
agents in the same pipeline to use different backends. See
[threads.md](./threads.md) for template configuration.

## Thinking level

The optional `thinking` profile field sets the backend's reasoning depth,
in the backend's own value set. Claude Code accepts
`low`/`medium`/`high`/`xhigh`/`max` and receives it as the `--effort`
flag; PI accepts `off`/`minimal`/`low`/`medium`/`high`/`xhigh` and
receives it as the session's thinking level. When the field is absent the
backend applies its own default.
Fallback entries do not inherit the primary's value — each entry declares
its own.

## Fallback behavior

Each profile entry can specify a `fallback` array of alternative profiles.
If the primary backend call fails with a transient error (network timeout,
rate limit, authentication), Cortex iterates through the fallback chain in
order. Each fallback entry inherits unspecified fields from the primary.

Example:

```json
{
  "plan": {
    "model": "claude-sonnet-4-20250514",
    "backend": "claude",
    "fallback": [
      { "model": "claude-sonnet-4-20250514", "backend": "pi" }
    ]
  }
}
```

## Usage-limit throttling and auto-resume

The fallback chain handles individual failed calls. A separate mechanism
handles rolling usage windows. Provider identifiers are opaque strings, so
the throttle can track any number of providers without a fixed provider
enum. Each provider keeps its own window types and reset times. A provider
and route mode are gated without blocking another provider that happens to
use the same mode name.

The policy is configured in [`config/settings.json`](./configuration.md#configsettingsjson)
as `providerRateLimits`, an object keyed by provider id. Each provider can
hold a `windows` array of `{ type, label?, enabled, threshold? }` entries, so
5-hour, weekly, weekly-overage, Codex primary/secondary, and labeled model
windows are independently configurable. `threshold` is a ratio greater than
`0` and at most `1`; an omitted value uses `0.95` for known weekly windows and
`0.90` otherwise. Exact window policy takes precedence over the visible,
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

Interrupted direct conversations and threads are stored with the provider
that limited them. When one provider fully recovers, Cortex resumes only that
provider's work; entries belonging to other active providers remain queued.
A direct conversation resumes in its own channel with the prior context
intact. A thread whose interrupted step had already streamed real work
resumes that step's backend session with a short continuation reminder, so
partial progress is kept; a step that never produced any activity is rerun
from its original prompt. Resume starts are staggered so a freshly opened
window is not immediately exhausted.

The active rate-limit details show the waiting direct-session and thread
counts for each provider and preserve labels for simultaneous model-scoped
windows. The provider key is the isolation boundary: multiple accounts or
quota pools reported under the same provider key share one provider record,
and windows with the same type and label retain the later reset time. Timed
throttling requires a reset-bearing observation. Claude live account-usage
pulls submit every reported window for each configured Anthropic mode, while
stale PI cache reads are never replayed; PI response-header observations
continue to arrive through their push path.

Policy edits apply only to future quota observations. They do not rewrite a
window that is already active. An active quota window or outage retry window
stays in force until its reset time or a manual **Resume now** clear. Outage
retry behavior uses its own outage windows and is unaffected by quota-policy
threshold edits.

Throttle windows and provider-attributed resume entries persist in
`data/provider-state.json`. On startup Cortex re-arms active timers and
immediately resumes entries whose provider window expired during downtime,
even when a different provider remains limited. Provider-less entries from
older data wait until every active provider clears. A busy direct channel or
a thread that has since finished is skipped; elapsed age alone does not
discard work.

Auto-resume is on by default. Set `"autoResume": false` in
[`config/settings.json`](./configuration.md#configsettingsjson) to drop ready
resume entries instead of dispatching them automatically; the change takes
effect without a daemon restart. The legacy `CORTEX_AUTO_RESUME=0` variable in
`.env` is still read as a deprecated fallback.

## Cost reporting

Cost reporting differs by backend:

- **Claude Code** — reverse-derives USD cost from `message.usage` token
  counts (input/output) using Anthropic's published per-model pricing.
  Costs are written to `$CORTEX_HOME/data/costs.jsonl`.
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
2. **`EngineSession`** — exposes `run(prompt, opts)` for one turn, returning an
   `EngineRun` whose `events` is an async iterable of `RunEvent` and whose
   `result` is the foreground `AgentResult`; plus `steer()`,
   `respondToDialog()`, `compact()`, `close()`, and `kill()`.
3. **`event-parser.ts`** — translates the backend's native event format into
   `NormalizedEvent` / `RunEvent` members.
4. **Registration** — add the adapter to the assembly in
   `domain/runs/adapters.ts` and a branch to `SessionEngines.acquire` in
   `domain/runs/engines.ts`; add capabilities to `capabilities.ts`; include the
   backend label in the `Backend` type union in `core/types/agent-types.ts`.

The normalization layer (`agent-adapter/normalize/`) provides shared utilities
for event stream queuing, tool name translation, and hook specification that
all backends use.
