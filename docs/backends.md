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

**Print mode** (`claudeBackend: "print"`, default). Uses `claude -p
--stream-json` for one-shot turns. Each user message spawns a fresh Claude
invocation. Fast, stateless, and the recommended mode for most use cases.

**TUI mode** (`claudeBackend: "tui"`). Spawns an interactive Claude session
under tmux and tails the session's JSONL file for events. Supports
multi-turn conversation with session persistence. Heavier resource usage
but allows interactive workflows.

Claude Code adapter session pool is keyed by channel for session reuse.
Cost reporting reverse-derives USD from `message.usage` token counts using
Anthropic's published pricing.

## PI

Full feature parity with Claude Code. PI's adapter bridges the gap where
PI's native feature set differs:

- **MCP** — implemented via `mcp-bridge.ts`, an extension that connects PI
  to Cortex's MCP server. Auto-injected via `--extension` at spawn time.
- **PlanMode / AskUserQuestion** — implemented via `tool-shims.ts` pseudo
  tools that register `ask`, `exit_plan`, and `todo` as first-class PI
  tools, routing responses through `extension_ui_response`.
- **Hooks** — implemented via `hook-bridge.ts`, which translates PI tool
  events to Cortex hook scripts.
- **Plugins** — PI's native `--skill` flag maps to Cortex's plugin system.

PI sessions use `--session <path>` for resume and `--system-prompt` for
system prompt override. The adapter handles LF-only NDJSON framing for
PI's event stream.

PI provider names are independent of Cortex backend names. In particular,
`openai-codex` is a supported PI provider (including the
`openai-codex-responses` API kind); profiles using it still set
`"backend": "pi"`.

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

Interrupted direct conversations and threads are stored with the provider
that limited them. When one provider fully recovers, Cortex resumes only that
provider's work; entries belonging to other active providers remain queued.
A direct conversation resumes in its own channel with the prior context
intact, while a thread reruns its interrupted step. Resume starts are
staggered so a freshly opened window is not immediately exhausted.

The active rate-limit details show the waiting direct-session and thread
counts for each provider. The provider key is the isolation boundary:
multiple accounts or quota pools reported under the same provider key share
one provider record, and same-type windows retain the later reset time.
Automatic recovery also requires a reset-bearing provider event. The Claude
print adapter supplies that event; an adapter that only reports a failed call
or low remaining usage does not create a timed throttle by itself.

Throttle windows and provider-attributed resume entries persist in
`schedules.json`. On startup Cortex re-arms active timers and immediately
resumes entries whose provider window expired during downtime, even when a
different provider remains limited. Provider-less entries from older data
wait until every active provider clears. A busy direct channel or a thread
that has since finished is skipped; elapsed age alone does not discard work.

Auto-resume is on by default. Set `CORTEX_AUTO_RESUME=0` in the `.env` file to
drop ready resume entries instead of dispatching them automatically.

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
