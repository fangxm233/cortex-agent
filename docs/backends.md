# Backends

A backend is Cortex's adapter for a specific coding-agent CLI. Cortex
does not call LLM APIs directly. It spawns a coding agent (Claude Code
or PI) as a child process, sends messages to it, and consumes a
normalized event stream. Each backend implements the `AgentAdapter`
interface defined in `agent-server/src/agent-adapter/types.ts`.

## Supported backends

| Backend | Status | Binary | npm package | Feature level |
|---|---|---|---|---|
| Claude Code | Supported | `claude` | `@anthropic-ai/claude-code` | Full (10/10 capabilities) |
| PI | Supported | `pi` | `@mariozechner/pi-coding-agent` | Full (10/10 capabilities) |

## How backends work

When an agent session starts, Cortex resolves the active profile (from
`profiles.json` or the `--profile` flag) to determine which backend to use.
It then calls `getAdapter(backend)` to get the adapter instance and calls
`adapter.spawn(config)` to start a session.

The `AgentSpawnConfig` carries the full session context: system prompt,
plugin directories, tool allowlist, MCP server config, hooks, model name,
and backend-specific passthroughs. The adapter translates this into
backend-native CLI arguments and spawns the coding agent.

From there, Cortex sends user messages and receives a normalized event
stream. The normalization layer (`agent-adapter/normalize/`) translates
each backend's native event format into a common `NormalizedEvent`
discriminated union, so the orchestration layer never needs to know which
backend is running.

## Feature matrix

Cortex defines ten capabilities that a backend may support. The
orchestration layer checks capabilities before attempting backend-specific
operations.

| Capability | Claude Code | PI | Description |
|---|---|---|---|
| `hooks` | yes | yes | PreToolUse/PostToolUse/Stop hooks via hook-bridge |
| `plugins` | yes | yes | Role-scoped skill plugins via `--skill` or equivalent |
| `mcp` | yes | yes | MCP tool server integration |
| `plan-mode` | yes | yes | EnterPlanMode/ExitPlanMode tool support |
| `ask-user-question` | yes | yes | AskUserQuestion tool support |
| `system-prompt-override` | yes | yes | Custom system prompt injection |
| `session-resume` | yes | yes | Resume an existing session |
| `tool-allowlist` | yes | yes | Restrict available tools to a subset |
| `streaming-deltas` | yes | yes | Publish token-level assistant text during generation |
| `mid-turn-inject` | yes | yes | Accept user input into a turn already in flight |

## Claude Code

The reference backend. Supports all ten capabilities. Two
adapter modes are available:

**Print mode** (`claudeBackend: "print"`, default). Uses a persistent
`claude -p` process with stream-json input and output. Cortex pools the process
by session key and sends later turns over the same NDJSON stream until the
session is closed, times out, or its spawn identity changes.

**TUI mode** (`claudeBackend: "tui"`). Spawns an interactive Claude session
under tmux and tails the session's JSONL file for events. Supports
multi-turn conversation with session persistence. Heavier resource usage
but allows interactive workflows.

Claude Code adapter session pool is keyed by channel for session reuse.
Cost reporting reverse-derives USD from `message.usage` token counts using
Anthropic's published pricing.

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

PI provides the same Cortex capabilities through adapter extensions.
`mcp-bridge.ts` connects PI to one composition-scoped Cortex MCP process and to
independent assigned plugin MCP servers. User-initiated direct sessions include
the interaction registrations in that Cortex process. Claude TUI, Claude print,
and PI therefore expose the same `cortex_ask_user`, `cortex_plan_enter`, and
`cortex_plan_exit` tools with the same blocking webhook handlers. `tool-shims.ts` supplies the remaining PI-local Agent,
TodoWrite, WebFetch, and WebSearch tools. `hook-bridge.ts` translates PI tool
events to Cortex hook scripts, and PI's native `--skill` flag carries Cortex
plugin skills.

PI sessions use `--session <path>` for resume and `--system-prompt` for
system prompt override. The adapter handles LF-only NDJSON framing for
PI's event stream.

PI transcript retention is filesystem-based. Active PI backend session ids are
protected during retention sweeps, while orphan transcript bundles under
`$CORTEX_HOME/logs/sessions-pi/` are deleted only after they stay unreferenced
past the retention cutoff and survive a second confirmation sweep.

PI provider names are independent of Cortex backend names. In particular,
`openai-codex` is a supported PI provider (including the
`openai-codex-responses` API kind); profiles using it still set
`"backend": "pi"`.

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

The optional `thinking` profile field sets the backend's reasoning depth.
Each backend receives it in its native flag: Claude Code as
`--effort <level>` (`low`/`medium`/`high`/`xhigh`/`max`), PI as
`--thinking <level>` (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`).
When the field is absent no flag is passed and the backend uses its own
default, so existing profiles behave unchanged.
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
- **PI** — cost reporting depends on the PI coding agent's provider
  configuration. The adapter captures whatever cost metadata PI emits.

All cost records follow the same JSONL format and are subject to a 90-day
rolling retention window. Cost queries via MCP tools aggregate across all
backends — see [mcp.md](./mcp.md) for the `cost_query` tool.

## Adding a new backend

New backends implement the `AgentAdapter` interface in a new directory
under `agent-server/src/agent-adapter/`. The required surface:

1. **`adapter.ts`** — implements `AgentAdapter` with `spawn()`, `close()`,
   `kill()`, and `listSessions()`. Returns an `AgentProcess` from `spawn()`.
2. **`AgentProcess`** — exposes `send(message)` for user messages and
   `events` as an async iterable of `NormalizedEvent`. Must also support
   `close()` and `kill()`.
3. **`event-parser.ts`** — translates the backend's native event format to
   `NormalizedEvent` discriminated union members.
4. **Registration** — add the adapter to the `ADAPTERS` map in
   `agent-adapter/index.ts`, add capabilities to `capabilities.ts`, and
   include the backend label in the `Backend` type union in `types.ts`.

The normalization layer (`agent-adapter/normalize/`) provides shared
utilities for event stream queuing, tool name translation, and hook
specification that all backends use.
