# Hooks

A hook is a command Cortex runs when something happens — a tool is about to
execute, a session starts, a schedule fires, an assistant turn ends. Every hook is a
**declaration**: one JSON file that names an event, an optional matcher, and the
command to run. The built-in declarations ship with Cortex and are read from its
install; yours live in `$CORTEX_HOME/config/hooks/`. The server loads those
declarations at startup, and each consumer compiles the subset it cares about:
the Claude Code backend, the PI backend, and the server's own event dispatcher.
Adding a hook means adding a file, not changing code. For where hooks sit in the
overall system, see [architecture.md](./architecture.md).

## Architecture overview

```
  defaults/config/hooks/*.json + $CORTEX_HOME/config/hooks/*.json
              — one declaration per file, built-in and yours
                            │
                            │  load + validate (store/hook-registry.ts)
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                        ▼
 Claude compiler       PI hook bridge            HookBus
 hooks-builder.ts      pi/hook-bridge.ts         core/hook-bus.ts
 agent:* + cc:*        agent:* + pi:*            cortex:*
        │                   │                        │
        ▼                   ▼                        ▼
 --settings JSON at    pi.on(<native event>)    server-side dispatch
 Claude spawn time     at extension load
        └───────────────────┴────────────────────────┘
                            │
                            ▼
     $CORTEX_HOME/hooks/*.mjs, then defaults/hooks/*.mjs — the scripts
```

## The hook registry

The registry has two layers. The built-in declarations are the `.json` files in
the install's `agent-server/defaults/config/hooks/`, read in place, so they
always match the running version. Yours are the `.json` files in
`$CORTEX_HOME/config/hooks/`. Each file is one declaration. Files from both
layers are read in sorted filename order, which is also the order hooks run in
for the same event — the built-in declarations carry numeric prefixes (`05-…`,
`06-…`) so their relative order is explicit.

A file in `$CORTEX_HOME/config/hooks/` with the same name as a built-in
declaration overrides it rather than adding a hook. It is merged over the
built-in declaration one top-level field at a time, so it only needs the
fields it changes — `{ "enabled": false }` switches a built-in hook off — and
the built-in `id` is kept. A field the override sets replaces the built-in
field whole: an override of `run` must restate the complete `run` object,
`script` included. Deleting the file restores the built-in declaration. A sealed home
(`CORTEX_CONFIG_IMMUTABLE=1`, as in a benchmark trial) mounts only its own
declarations.

Loading is fail-soft and loud. A file that isn't valid JSON, fails schema
validation, or reuses an `id` already claimed by an earlier file is skipped with
`[hook-registry] skipped <file>: <reason>` on stderr; the rest of the registry
still mounts. An override that cannot be parsed is reported the same way, and
the built-in declaration it was meant to change mounts unchanged. At startup
the server logs how many enabled hooks mounted, in the form
`Startup: mounted 7 hooks (0 cc / 1 cortex)`. The Web UI settings panel reads
the same list.

The desktop **Settings → Hooks** panel is a full view of that registry rather
than a listing: it groups declarations by event namespace in load order, shows
where each one actually mounts (`claude` / `pi` / `server`), whether a change
takes effect on the next agent spawn or only after a server restart, and flags a
`run.script` that neither scripts directory has. What you may change there
follows the entry's source. A **user** entry is fully editable and can be created
or deleted. A **built-in** entry offers only the enabled switch; flipping it
writes the minimal override to `$CORTEX_HOME/config/hooks/`, and flipping it back
removes that override again. The `result` choice is constrained to the modes the
event can actually carry, and an entry created from the UI is always a user
entry. Each entry can also be run against an editable sample payload, with
the exit code, stdout and stderr shown inline; a test run from the panel stops
after 15 seconds whatever the declared timeout. Filter chips and a search box
narrow the list.

On mobile the same registry is read-only: the hooks screen shows the grouped
inventory and the full declaration behind each row, but no editing, creation or
test run. Change hooks from a desktop session.

### Entry schema

```json
{
  "id": "status-md-guard",
  "event": "agent:pre-tool",
  "matcher": "Edit|Write",
  "run": { "script": "status-md-guard.mjs", "timeout": 10 },
  "enabled": true
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string, required | Unique across the registry. Used by `cortex-hook` and in log lines |
| `event` | string, required | One of the `agent:*` events, or any `cc:` / `pi:` / `cortex:` prefixed name |
| `matcher` | string or object | Regex for `agent:*` / `cc:*` / `pi:*` events; equality filter object for `cortex:*` events. Omit to match everything |
| `run.script` | string | Script filename, looked up in `$CORTEX_HOME/hooks/` and then in the built-in scripts. Absolute paths and `..` segments are rejected |
| `run.command` | string | A raw shell command instead of a script. Exactly one of `script` or `command` must be present |
| `run.timeout` | number | Timeout in **seconds**, a positive number. Defaults to 30 on PI and the server; on Claude an absent timeout leaves Claude Code's own default |
| `scope.backends` | array | Narrows which of `claude` / `pi` an `agent:*` hook compiles to |
| `scope.requiresTool` | string | On Claude, mounts the hook only when the agent's tool list contains that tool |
| `blocking` | object | `{ "mode": "webhook", "ttlMin": <positive number> }`. Descriptive metadata for a hook that blocks on a webhook round trip: the loader validates it and the settings panel shows it, but nothing enforces it at runtime |
| `result` | string | How a `cortex:*` hook's stdout is used: `stdout-as-prompt` (accepted only on `cortex:session.new` and `cortex:session.messageEnd`) or `none`. The loader rejects a mode the event cannot carry |
| `version` | string | Optional CalVer version of the declaration, shown read-only in the settings panel |
| `enabled` | boolean | `false` removes the hook from every consumer without deleting the file. Defaults to `true` |

The loader also rejects a `matcher` regular expression that does not compile,
an object matcher whose values are not plain strings, numbers or booleans, and
an `event` that is neither one of the seven `agent:*` names nor a `cc:`,
`pi:` or `cortex:` prefix followed by a name.

### Built-in and user entries

An entry declared in the install is **built-in**, whether or not a file in
`$CORTEX_HOME/config/hooks/` overrides some of its fields; `cortex-hook` and the
settings panel report it as such. An entry declared only in
`$CORTEX_HOME/config/hooks/` is a **user** entry. Cortex never writes to the
install, and it writes to `$CORTEX_HOME/config/hooks/` only when you edit, add,
delete or switch a hook.

## Event namespaces

### `agent:*` — backend-neutral agent events

These are the events both coding-agent backends genuinely agree on. One
declaration compiles to Claude Code and to PI at the same time, and the payload
handed to the script is Claude-shaped in both cases, so a single script serves
both.

| `agent:*` event | Claude event | PI event |
|---|---|---|
| `agent:pre-tool` | `PreToolUse` | `tool_call` |
| `agent:post-tool` | `PostToolUse` | `tool_result` |
| `agent:session-start` | `SessionStart` | `before_agent_start` |
| `agent:session-end` | — | `session_shutdown` |
| `agent:pre-compact` | — | `session_before_compact` |
| `agent:user-prompt` | — | `input` |
| `agent:turn-end` | — | `turn_end` |

The Claude compiler emits settings for the first three; the last four reach PI
only. To hook the corresponding Claude mount points, declare them natively as
`cc:SessionEnd`, `cc:PreCompact`, `cc:UserPromptSubmit`, or `cc:Stop`.

### `cc:*` — Claude Code passthrough

Everything after `cc:` is used verbatim as the Claude settings event name, so
any Claude Code mount point is reachable without code changes —
`cc:PermissionRequest`, `cc:SessionEnd`, `cc:PreCompact`, `cc:UserPromptSubmit`,
`cc:Stop`. These declarations mount on the Claude backend only. Note that Cortex
spawns Claude with `--permission-mode bypassPermissions`, so `cc:PermissionRequest`
never fires as things stand.

### `pi:*` — PI passthrough

Everything after `pi:` is registered directly as a PI extension event, so
PI-only mount points such as `pi:session_start` or `pi:before_provider_headers`
are reachable the same way. These mount on the PI backend only, and the script
receives the raw PI event object, with `hook_event_name`, `session_id` and
`cwd` added, rather than a Claude-shaped payload.

### `cortex:*` — server-side events

These fire inside the agent-server process itself, dispatched by the HookBus.

| Event | Fires when | Payload fields |
|---|---|---|
| `cortex:server.start` | The server finishes wiring and starts serving | `version`, `pid` |
| `cortex:server.shutdown` | The server receives `SIGTERM` | `version`, `pid`, `reason` |
| `cortex:schedule.fired` | A schedule fires | `scheduleId`, `name`, `project` |
| `cortex:client.connected` | A remote device client registers | `device` |
| `cortex:client.disconnected` | A remote device client drops | `device`, `reason` when known |
| `cortex:session.new` | A session is closing via `!new` or the "New" status button | `channel`, `sessionId`, `backendSessionId`, `executionId`, `backend`, `model`, `trigger` (`new`), `timestampIso` |
| `cortex:session.messageEnd` | An assistant turn completes | same shape, with `trigger` set to `messageEnd` |

In `cortex:schedule.fired`, `name` carries the schedule's message and
`project` its `projectId`. The event fires once the schedule's `preCheck` has
passed, before Cortex checks whether the run can start, so it also fires for a
run that is then skipped.

### Matchers

For `agent:*`, `cc:*`, and `pi:*` events the matcher is a regular expression
tested against the tool name. `agent:*` and `cc:*` matchers use Claude's
PascalCase names (`Edit|Write`, `Read|Grep`); on the PI side the bridge maps
PI's `edit` / `read` / `web_fetch` style names up to those canonical names
before testing, so one matcher covers both backends. `pi:*` matchers are tested
against PI's native tool names as-is. Non-tool events match differently: Claude
tests a `SessionStart` matcher against the start reason
(`startup|resume|clear|compact`), and the PI bridge applies matchers only to
tool events, ignoring them on lifecycle events.

For `cortex:*` events the matcher is an object of equality filters, and every
key must be present in the payload with exactly that value. A
`cortex:client.disconnected` hook with `{"device": "gpu-box"}` fires only when
that one device drops, not for every client.

## Compiling to the agent backends

### Claude Code

At spawn time, `buildHooksSettings()` in
`agent-adapter/claude/hooks-builder.ts` loads the registry, keeps the entries
that are enabled, mount on the `claude` backend, and pass their
`scope.requiresTool` check against the agent's tool list, then emits a Claude
settings object injected through the `--settings` CLI flag. `run.script`
becomes `node <script path>` — the script in `$CORTEX_HOME/hooks/` when there is
one, otherwise the built-in script in the install, and a script from
`$CORTEX_HOME/hooks/` also gets the `--import` preload that resolves its imports
of the built-in helpers. `run.command` is passed through
verbatim, and `run.timeout` becomes Claude's per-hook `timeout` in seconds.
Consecutive entries on the same event with the same matcher are merged into one
matcher group:

```json
{
  "PreToolUse": [
    { "matcher": "Edit|Write", "hooks": [
        { "type": "command", "command": "node <install>/defaults/hooks/status-md-guard.mjs", "timeout": 10 }
    ]}
  ],
  "PostToolUse": [
    { "matcher": "Read|Grep", "hooks": [ ... ] },
    { "matcher": "Read|Edit|Write|Skill", "hooks": [ ... ] },
    { "matcher": "Read|Edit", "hooks": [ ... ] }
  ],
  "SessionStart": [ ... ]
}
```

Because the registry is read on every spawn, a new declaration takes effect on
the next agent that starts.

### PI

`agent-adapter/pi/hook-bridge.ts` runs as the `cortex-hook-bridge` PI
extension, inside the server process. On load it takes the registry entries
that mount on the `pi` backend and calls `pi.on()` once per entry, with the
native event name from the `agent:*` mapping table above or the literal suffix
of a `pi:*` event. `scope.requiresTool` is not applied on PI.

For `agent:*` entries the bridge normalizes PI's shapes into the Claude form the
hook scripts expect: the tool name is mapped to PascalCase (`edit` → `Edit`,
`web_fetch` → `WebFetch`), and `input.path` is copied to `input.file_path` for
the `read` / `write` / `edit` tools. The payload carries `hook_event_name` (the
Claude name — `SessionEnd`, `PreCompact`, `UserPromptSubmit` and `Stop` for the
four PI-only events), `session_id`, `tool_name`, `tool_input`, `tool_use_id`,
and `cwd`; tool-result events add `tool_output`, `tool_response`, and
`is_error`. Hook processes get `CORTEX_SESSION_ID` in their environment.

A `run.script` that exports a `runHook(payload, env)` function is imported and
called in-process instead of being spawned as a child; its return value is
treated like the JSON a spawned script prints.

Script output is honored natively. On `tool_call`, a
`hookSpecificOutput.permissionDecision` of `deny` blocks the tool and surfaces
`permissionDecisionReason`, and `hookSpecificOutput.updatedInput` replaces the
tool input. On `tool_result`, `hookSpecificOutput.additionalContext` is appended
to the tool's content. On `before_agent_start`, that same field is appended to
the system prompt. `pi:*` entries can additionally return `{"block": true}` on
`pi:tool_call`, replace `input` wholesale, and rewrite `headers` on
`pi:before_provider_headers`.

## The server-side dispatcher

`core/hook-bus.ts` dispatches `cortex:*` events. The server snapshots the
registry into the bus at startup, so a newly added `cortex:*` declaration takes
effect the next time the server starts.

When an event is emitted, the bus selects the enabled entries whose `event`
matches exactly and whose object matcher is satisfied by the payload, then runs
them one at a time. Each hook runs as `sh -c '<command> "$@"' hook <args>` with
the working directory set to `$CORTEX_HOME` and the payload delivered as JSON on
stdin. `run.timeout` seconds is the process limit — 30 by default, and session
events use 60 unless the declaration says otherwise.

What the bus does with stdout depends on `result`:

- `stdout-as-prompt` — trimmed stdout is used as a prompt. Session events use
  this to inject a turn.
- `none`, or omitted — output is discarded; the hook is fire-and-forget.

A hook that times out or exits non-zero is logged to the daemon log with the
tail of its stderr, and skipped; session-event hooks also log their stderr when
they succeed. A hook never fails the surrounding operation.

## Session events and prompt injection

`cortex:session.new` fires before a session is torn down by `!new` or the "New"
status button, when a hook is declared for it and the channel has an active
session. `cortex:session.messageEnd` fires after each assistant turn of a
session that has a live stream.
Both are declared like any other hook; the built-in `session-new-hook`
declaration points at `new-session-hook.mjs` with `result` set to
`stdout-as-prompt`.

`sessionId` is the Cortex session id — the key of the session registry, from
which the `cortex-hook` helpers resolve a channel. `backendSessionId` is the
backend's own id for the session's conversation (the name of its transcript),
or `null` while the session has had no turn; the two differ once the backend has
assigned its own id or a rewind has moved the conversation.

Beyond the JSON payload on stdin, session hooks receive `CORTEX_HOOK_CHANNEL`,
`CORTEX_HOOK_SESSION_ID`, `CORTEX_HOOK_TRIGGER`, and
`CORTEX_HOOK_EXECUTION_ID` in the environment, plus
`CORTEX_HOOK_BACKEND_SESSION_ID` when the session has a backend conversation.
Non-empty stdout is injected as a fresh agent turn that resumes that
conversation — for `session.new` on an isolated session key that is closed
afterwards, so the pre-close turn cannot resurrect the old session under the
channel; for `session.messageEnd` on the channel itself, so the follow-up
continues the live conversation and its output threads under the reply that
triggered it. A session with no backend conversation has nothing to resume, so
its hook output is shown but not injected.

## The hook-bridge: blocking calls over HTTP

Two interactions need a human in the loop, which the agent process cannot do on
its own: asking the user a question, and getting a plan approved. Both POST to
the server's loopback webhook listener (`WEBHOOK_PORT`, default 3001) on
`/hook/ask-user-question` and `/hook/exit-plan-mode`, authenticated with the
`CORTEX_WEBHOOK_TOKEN` bearer token in the `x-cortex-token` header, and block on
the response. A question posted with `blocking: false` returns as soon as the
card is up.

Agents reach that bridge through the `cortex_ask_user` and `cortex_plan_exit`
MCP tools, and hook scripts reach it through `cortex-hook-api.mjs` / the
`cortex-hook ask` CLI (see [Asking the user from a hook](#asking-the-user-from-a-hook)).
Claude's native `AskUserQuestion` and `ExitPlanMode` are not part of a Cortex
session that has the interaction tools, so no hook needs to intercept them.

On the server, `orchestration/routing/hook-bridge.ts` registers a pending
promise with a 30-minute TTL and publishes `ask-user.requested` or
`plan.submitted` on the event bus. The subscribers in
`hook-bridge-subscribers.ts` present them on the session's platform — an inline
card on the Web UI, interactive messages on Slack and Feishu (see
[safety-and-approvals.md](./safety-and-approvals.md#where-the-cards-appear)).
When the user responds, the interaction handler resolves the promise and the
HTTP response returns to the waiting caller.

## Hook scripts

Scripts are ordinary Node.js `.mjs` files: read JSON context from stdin, write
JSON (or, for `stdout-as-prompt` hooks, plain text) to stdout. The built-in
scripts run in place from the install's `agent-server/defaults/hooks/`; yours
live in `$CORTEX_HOME/hooks/`. A script name is looked up in
`$CORTEX_HOME/hooks/` first, so a file there with a built-in script's name
replaces it, and deleting the file restores the built-in one. A script in
`$CORTEX_HOME/hooks/` can import the built-in helper libraries
(`./cortex-hook-api.mjs`, `./cortex-context-lib.mjs`, …) by the same relative
path the built-in scripts use: an import that `$CORTEX_HOME/hooks/` cannot
satisfy is resolved against the built-in scripts directory. The built-in
scripts are:

| Script | Used by | Purpose |
|---|---|---|
| `status-md-guard.mjs` | `agent:pre-tool`, `Edit\|Write` | Keeps a project's `STATUS.md` and `ISSUES.md` and the memory tree's `AGENTS.md` indexes within their size caps (see below) |
| `memory-ref-tracker.mjs` | `agent:post-tool`, `Read\|Grep` | Records experiment, knowledge and pattern accesses to `_meta/access-log.jsonl` (see [Reference tracking](#reference-tracking)) |
| `rules-loader.mjs` | `agent:post-tool`, `Read\|Grep` | Injects path-scoped [rules](./configuration.md#built-in-assets-and-your-overrides) — the built-in ones and those in `$CORTEX_HOME/rules/` — when a matching path is read, once per session per rule |
| `session-activity-tracker.mjs` | `agent:post-tool`, `Read\|Edit\|Write\|Skill` | Appends activity records to `logs/session-activity/<session_id>.jsonl` |
| `agents-md-injector.mjs` | `agent:post-tool` (`Read\|Edit`) and `agent:session-start` | Injects the AGENTS.md ancestor chain into agent context, deduplicated per session |
| `new-session-hook.mjs` | `cortex:session.new` | Recalls valuable information from the closing session and writes it to the context files |

A declaration may run an inline `run.command` instead of a script.

The size caps `status-md-guard` enforces:

| File | Warns at | Denied above |
|---|---|---|
| `context/projects/<project>/STATUS.md`, `ISSUES.md` | 60 lines or 4 KB | 80 lines or 6 KB |
| Any `AGENTS.md` under `context/` | 90 lines or 6.5 KB | 120 lines or 8 KB |

An edit that crosses either limit is denied with advice on what to trim. An
edit that shrinks a file already over its cap is allowed with a warning, so an
oversized file can be cut down step by step.

Several files among the built-in scripts are not hook entries.
`cortex-hook-api.mjs` is a helper library that hook scripts import (see below).
`cortex-context-lib.mjs` holds the AGENTS.md dedup cache, the inline size budget
and the rules `paths:` parser shared by `agents-md-injector.mjs`,
`rules-loader.mjs` and the server, so the hooks and the MCP-side injection of
remote AGENTS.md files read and write the same per-session cache.
`git-support.mjs` is the Git helper `memory-ref-tracker.mjs` uses, and
`overlay/` holds the `--import` loader that lets a script in
`$CORTEX_HOME/hooks/` import the built-in helpers.

## Asking the user from a hook

Any hook can pose an ask-user-question card on the message platform bound to the
current session — Slack, Feishu, or the Web UI — and block until the user
answers. The card is the same interactive form the `cortex_ask_user` tool
produces, and it accepts an optional severity level (`info`, `warning`, or
`error`, with `warn` as an alias) that renders with the Web UI's notice tones
and an icon prefix on Slack and Feishu. Without a level the card keeps its
neutral look.

Node hook scripts import the helper by its relative path, which a script in
`$CORTEX_HOME/hooks/` can use too (see [Hook scripts](#hook-scripts)).
`askUser` takes `questions`, `level`, `channel`, `sessionId`, `dryRun`, and a
client-side `timeoutMs` (60 minutes by default), and resolves to
`{ answers, error? }`; `error` is `timeout`, `post_failed` or
`bus_not_initialized`.

```js
import { askUser } from './cortex-hook-api.mjs';

const { answers, error } = await askUser({
  questions: [{
    question: 'Disk is almost full — clean old checkpoints?',
    header: 'Disk',
    options: [{ label: 'Clean' }, { label: 'Keep' }],
  }],
  level: 'warning',
});
if (error === 'timeout') process.exit(0); // user did not answer — pick a safe default
```

`run.command` hooks (and anything shell-based) use the CLI instead:

```bash
cortex-hook ask --question "Disk is almost full — clean old checkpoints?" \
  --options "Clean|Keep" --level warning
# → { "ok": true, "answers": { "Disk is almost full — clean old checkpoints?": "Clean" } }
```

Both entry points POST to the server's `/hook/ask-user-question` webhook with
the `CORTEX_WEBHOOK_TOKEN` that hooks run by Cortex inherit, so they share one
routing and blocking contract:

- **Routing.** An explicit `channel` wins. Otherwise the helper and the CLI fall
  back to the hook environment: `CORTEX_HOOK_CHANNEL` (session hooks), then
  `SLACK_CHANNEL` (agent-side hooks). When only a `sessionId` is available
  (`CORTEX_HOOK_SESSION_ID`, or passed explicitly), the server resolves the
  session's channel from the session registry. Server events such as
  `cortex:schedule.fired` carry no channel, so their hooks must pass `channel`
  or `sessionId` themselves.
- **Blocking.** The server holds the request in the hook-bridge with a
  30-minute TTL. The response is `{ answers }`, or `{ error: "timeout",
  answers: {} }` when the TTL expires. `cortex-hook ask` exits `0` on answers,
  `2` on timeout, and `1` on other errors, so a shell hook can branch on `$?`.
  A hook that asks must set its `run.timeout` above the expected wait, and
  should declare `blocking: { "mode": "webhook", "ttlMin": 30 }` so the
  settings panel shows that it blocks.
- **Multiple questions.** `askUser` takes any non-empty question array;
  `cortex-hook ask --payload <file|->` accepts the same array as JSON, e.g.
  `cat questions.json | cortex-hook ask --payload - --session-id <id>`. Cortex
  does not impose a question-count maximum; the destination platform may still
  reject a payload that exceeds its own limits.
- **Smoke tests.** `--dry-run` (CLI) or `dryRun: true` (helper) journals the
  event and resolves synthetically without posting a card.

Agents themselves get the same severity option through the
`cortex_ask_user` MCP tool's `level` parameter.

## The cortex-hook CLI

`cortex-hook` inspects and operates the mounted hooks. Every command prints
JSON on stdout; `--help` prints text, and an error is reported on stderr with
exit code `1`.

| Command | Flags | What it does |
|---|---|---|
| `cortex-hook list` | — | Lists every mounted hook as `id`, `event`, `enabled`, `source` (`builtin` or `user`), and `overridden` for a built-in hook with an override file |
| `cortex-hook show` | `--id <id>` | Prints one complete declaration, including `source` |
| `cortex-hook enable` | `--id <id>`, `--dry-run` | Sets `enabled: true`, idempotently: in the declaration file for a user hook, in the override file for a built-in one |
| `cortex-hook disable` | `--id <id>`, `--dry-run` | Sets `enabled: false` the same way |
| `cortex-hook test` | `--id <id>`, `--payload <file\|->` | Runs the hook once with the payload on stdin, in `$CORTEX_HOME`, with a 30-second default timeout |
| `cortex-hook ask` | `--question`, `--header`, `--options "a\|b"`, `--level`, `--channel` / `--session-id`, `--payload <file\|->`, `--multi`, `--dry-run` | Posts an ask-user card on the session's platform and blocks for the answer (exit `2` on timeout). `--header` defaults to the first 12 characters of the question |

`--help` / `-h` works on the root command and on each subcommand.

```bash
cortex-hook list
cortex-hook show --id session-new-hook
cortex-hook disable --id rules-loader --dry-run
cortex-hook test --id status-md-guard --payload payload.json
cat payload.json | cortex-hook test --id status-md-guard --payload -
```

`enable` and `disable` report `changed` so you can tell a real state change from
a no-op, and `--dry-run` adds a `would_set` block instead of writing. For a
built-in hook the override file holds only the switch, and returning the switch
to its built-in value deletes the file.

`test` returns `ok`, `id`, `exit_code`, `stdout`, `stderr`, and `error` when the
process failed, and exits with the hook's own exit code.

## Adding a hook

1. Write the script into `$CORTEX_HOME/hooks/`, for example
   `warn-sensitive-file.mjs`:

   ```javascript
   #!/usr/bin/env node
   const chunks = [];
   for await (const chunk of process.stdin) chunks.push(chunk);
   const input = JSON.parse(Buffer.concat(chunks).toString());

   const path = input.tool_input?.file_path || '';
   if (path.includes('.env') || path.includes('credentials')) {
     console.log(JSON.stringify({
       hookSpecificOutput: {
         hookEventName: 'PreToolUse',
         permissionDecision: 'deny',
         permissionDecisionReason: `Refusing to edit sensitive file: ${path}`
       }
     }));
     process.exit(0);
   }

   console.log(JSON.stringify({
     hookSpecificOutput: {
       hookEventName: 'PreToolUse',
       permissionDecision: 'allow'
     }
   }));
   ```

2. Declare it. Drop `$CORTEX_HOME/config/hooks/50-warn-sensitive-file.json`
   into the registry — the numeric prefix places it after the built-in entries:

   ```json
   {
     "id": "warn-sensitive-file",
     "event": "agent:pre-tool",
     "matcher": "Edit|Write",
     "run": { "script": "warn-sensitive-file.mjs", "timeout": 5 }
   }
   ```

3. Verify with `cortex-hook list` (the id appears with source `user`) and
   `cortex-hook test --id warn-sensitive-file --payload payload.json`.

An `agent:*`, `cc:*`, or `pi:*` hook applies to the next agent that spawns. A
`cortex:*` hook is picked up when the server next starts, because the bus
snapshots the registry at startup.

The same three steps cover server-side events — declare
`"event": "cortex:schedule.fired"` with a `matcher` such as
`{"project": "my-project"}` to run something whenever one of that project's
schedules fires.

## Reference tracking

The `memory-ref-tracker` hook implements automatic reference tracking for the
atomized memory system (see [memory.md](./memory.md) for the full architecture).
It records every Read and Grep that touches an experiment, knowledge, or
pattern entry — `EXP-NNN.md`, `K-NNN.md` or `PAT-NNN.md` under
`context/projects/<project>/` — as one JSONL record of the entry's filename,
the tool, and a timestamp:

```json
{"file": "EXP-012.md", "tool": "Read", "ts": "2026-05-19T10:30:00.000Z"}
```

A Grep inside a project that matches no entry file is recorded as
`"file": "_directory_search"`. The log lives at
`<project>/_meta/access-log.jsonl`. When `$CORTEX_HOME` is a Git repository,
the hook stages every changed `access-log.jsonl` and commits them as
`chore: update access log`, unless something else is already staged, in which
case it only stages them. Without Git, access tracking still writes the log.
Memory index regeneration reads it to compute access counts (`refs`) and
last-access timestamps (`last-ref`), which drive index sorting and hot/cold
classification.

## Debugging hooks

Start with `cortex-hook list` to confirm the hook is mounted and enabled, then
`cortex-hook test --id <id> --payload <file>` to run it in isolation with a
payload you control — that separates "the script is broken" from "the
declaration never matched". Server-side hook failures are logged to
`$CORTEX_HOME/logs/daemon.log` with the tail of the script's stderr.

- **Hook doesn't appear in `cortex-hook list`** — the loader rejected it. Look
  for `[hook-registry] skipped <file>` in the log: invalid JSON, a schema
  violation, or an `id` already used by an earlier file.
- **Hook is listed but never fires** — check the matcher. Tool matchers for
  `agent:*` and `cc:*` events use Claude's PascalCase names, and `cortex:*`
  matchers require every key to be present in the payload with exactly that
  value.
- **`agent:session-end`, `agent:pre-compact`, `agent:user-prompt`, or
  `agent:turn-end` has no effect on Claude** — those four compile to PI only.
  Use the `cc:` form for the Claude mount point.
- **New `cortex:*` hook does nothing** — the bus snapshots the registry at
  startup; restart the server.
- **JSON parse error** — stdout wasn't valid JSON. Make sure nothing but the
  result is written to stdout; diagnostics belong on stderr.
- **Timeout** — raise `run.timeout` (in seconds). The default is 30 seconds,
  or 60 for session events; on Claude an unset timeout falls back to Claude
  Code's own default.
- **`scope.requiresTool` has no effect on PI** — the PI bridge mounts the hook
  regardless; narrow it with `scope.backends` instead.
- **Script not found** — `run.script` is looked up in `$CORTEX_HOME/hooks/` and
  then among the built-in scripts; absolute paths and `..` segments are rejected
  by the loader.
