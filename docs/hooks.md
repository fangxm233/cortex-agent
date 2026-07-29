# Hooks

A hook is a command Cortex runs when something happens — a tool is about to
execute, a session starts, a thread ends, a task is completed. Every hook is a
**declaration**: one JSON file in `$CORTEX_HOME/config/hooks/` that names an
event, an optional matcher, and the command to run. The server loads those
declarations at startup, and each consumer compiles the subset it cares about:
the Claude Code backend, the PI backend, and the server's own event dispatcher.
Adding a hook means adding a file, not changing code. For where hooks sit in the
overall system, see [architecture.md](./architecture.md).

## Architecture overview

```
        $CORTEX_HOME/config/hooks/*.json   — one declaration per file
                            │
                            │  load + validate (store/hook-registry.ts)
        ┌───────────────────┼────────────────────────┐
        ▼                   ▼                        ▼
 Claude compiler       PI hook bridge            HookBus
 hooks-builder.ts      pi/hook-bridge.ts         core/hook-bus.ts
 agent:* + cc:*        agent:* + pi:*            cortex:*
        │                   │                        │
        ▼                   ▼                        ▼
 --settings JSON at    pi.on(<native event>)    server-side dispatch,
 Claude spawn time     at extension load        plus template-scoped
                                                thread hooks
        └───────────────────┴────────────────────────┘
                            │
                            ▼
              $CORTEX_HOME/hooks/*.mjs — the scripts themselves
```

## The hook registry

The registry is the directory `$CORTEX_HOME/config/hooks/`. Every `.json` file
in it is one hook declaration. Files are read in sorted filename order, which is
also the order hooks run in for the same event — the shipped declarations carry
numeric prefixes (`01-…`, `02-…`) so their relative order is explicit.

Loading is fail-soft and loud. A file that isn't valid JSON, fails schema
validation, or reuses an `id` already claimed by an earlier file is skipped with
`[hook-registry] skipped <file>: <reason>` on stderr; the rest of the registry
still mounts. At startup the server logs how much mounted, in the form
`Startup: mounted 12 hooks (1 cc / 2 cortex)`. The Web UI settings panel reads
the same list.

### Entry schema

```json
{
  "id": "sensitive-file-edit",
  "event": "agent:pre-tool",
  "matcher": "Edit|Write",
  "run": { "script": "sensitive-file-edit.mjs", "timeout": 10 },
  "enabled": true,
  "version": "2026.7.29"
}
```

| Field | Type | Meaning |
|---|---|---|
| `id` | string, required | Unique across the registry. Used by `cortex-hook` and in log lines |
| `event` | string, required | One of the `agent:*` events, or any `cc:` / `pi:` / `cortex:` prefixed name |
| `matcher` | string or object | Regex for `agent:*` / `cc:*` / `pi:*` events; equality filter object for `cortex:*` events. Omit to match everything |
| `run.script` | string | Script filename, resolved relative to `$CORTEX_HOME/hooks/`. Absolute paths and `..` segments are rejected |
| `run.command` | string | A raw shell command instead of a script. Exactly one of `script` or `command` must be present |
| `run.timeout` | number | Timeout in **seconds**. Defaults to 30 |
| `scope.backends` | array | Narrows which of `claude` / `pi` an `agent:*` hook compiles to |
| `scope.requiresTool` | string | Mounts the hook only when the agent's tool list contains that tool |
| `blocking` | object | `{ "mode": "webhook", "ttlMin": <positive number> }`, validated by the loader for hooks that block on a webhook round trip |
| `result` | string | `hook-result`, `stdout-as-prompt`, or `none`. Governs how a `cortex:*` hook's stdout is interpreted |
| `enabled` | boolean | `false` removes the hook from every consumer without deleting the file. Defaults to `true` |
| `version` | string | CalVer stamp (`2026.7.29`, optionally `-1`) marking the entry as managed |

### Managed and user entries

An entry carrying a valid CalVer `version` is **managed**: it is shipped with
Cortex and refreshed from `defaults/config/hooks/` at startup whenever the
shipped version is newer than the deployed one. An entry with no `version` is a
**user** entry and is never overwritten — that is the guarantee that lets you
drop your own declarations next to the shipped ones. Hook scripts sync the same
way, keyed on a `@cortex-hook-version` comment in the script source.

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
`cc:PermissionRequest` (which the shipped auto-allow hook uses), `cc:SessionEnd`,
`cc:PreCompact`, `cc:UserPromptSubmit`, `cc:Stop`. These declarations mount on
the Claude backend only.

### `pi:*` — PI passthrough

Everything after `pi:` is registered directly as a PI extension event, so
PI-only mount points such as `pi:session_start` or `pi:before_provider_headers`
are reachable the same way. These mount on the PI backend only, and the script
receives the raw PI event object rather than a Claude-shaped payload.

### `cortex:*` — server-side events

These fire inside the agent-server process itself, dispatched by the HookBus.

| Event | Fires when | Payload fields |
|---|---|---|
| `cortex:server.start` | The server finishes wiring and starts serving | `version`, `pid` |
| `cortex:server.shutdown` | The server receives `SIGTERM` | `version`, `pid`, `reason` |
| `cortex:thread.start` | Before a thread's first agent step | full thread context (below) |
| `cortex:thread.transition` | Between agent steps, after transitions are evaluated | full thread context |
| `cortex:thread.end` | After the thread's main loop finishes | full thread context |
| `cortex:dispatch.started` | A task is dispatched into a thread | `taskId`, `project`, `source`, `templateName` |
| `cortex:schedule.fired` | A scheduled task fires | `scheduleId`, `name`, `project` |
| `cortex:task.completed` | A task is marked complete | `taskId`, `project` |
| `cortex:task.blocked` | A task is blocked | `taskId`, `project`, `reason` |
| `cortex:client.connected` | A remote device client registers | `device` |
| `cortex:client.disconnected` | A remote device client drops | `device`, `reason` when known |
| `cortex:session.new` | A session is closing via `!new` or the "New" status button | `channel`, `sessionId`, `sessionName`, `executionId`, `profile`, `trigger` (`new`), `timestampIso` |
| `cortex:session.messageEnd` | An assistant turn completes | same shape, with `trigger` set to `messageEnd` |

The thread context carried by the three `cortex:thread.*` events is:
`threadId`, `templateName`, `phase`, `source`, `project`, `projectId`, `taskId`,
`taskProject`, `currentStepIndex`, `steps`, `activeAgent`, `previousAgent`,
`artifactContent`, `userMessage`, `totalCostUsd`, `pendingControlAction`.

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
key must be present in the payload with exactly that value. The shipped dispatch
hook uses `{"source": "task-dispatch"}` so it only fires for threads started by
task dispatch, not for every thread that ends.

## Compiling to the agent backends

### Claude Code

At spawn time, `buildHooksSettings()` in
`agent-adapter/claude/hooks-builder.ts` loads the registry, keeps the entries
that are enabled, mount on the `claude` backend, and pass their
`scope.requiresTool` check against the agent's tool list, then emits a Claude
settings object injected through the `--settings` CLI flag. `run.script`
becomes `node $CORTEX_HOME/hooks/<script>`, `run.command` is passed through
verbatim, and `run.timeout` becomes Claude's per-hook `timeout` in seconds.
Consecutive entries on the same event with the same matcher are merged into one
matcher group:

```json
{
  "PreToolUse": [
    { "matcher": "Edit|Write", "hooks": [
        { "type": "command", "command": "node $CORTEX_HOME/hooks/sensitive-file-edit.mjs", "timeout": 10 },
        { "type": "command", "command": "node $CORTEX_HOME/hooks/tasks-yaml-guard.mjs", "timeout": 10 }
    ]},
    { "matcher": "AskUserQuestion", "hooks": [ ... ] }
  ],
  "PostToolUse": [ ... ],
  "SessionStart": [ ... ],
  "PermissionRequest": [ ... ]
}
```

Because the registry is read on every spawn, a new declaration takes effect on
the next agent that starts. Setting `CORTEX_HOOKS_LEGACY=1` in the environment
bypasses the registry and emits a fixed built-in table instead.

### PI

`agent-adapter/pi/hook-bridge.ts` runs as a PI extension. On load it takes the
registry entries that mount on the `pi` backend and calls `pi.on()` once per
entry, with the native event name from the `agent:*` mapping table above or the
literal suffix of a `pi:*` event.

For `agent:*` entries the bridge normalizes PI's shapes into the Claude form the
hook scripts expect: the tool name is mapped to PascalCase (`edit` → `Edit`,
`web_fetch` → `WebFetch`), and `input.path` is copied to `input.file_path` for
the `read` / `write` / `edit` tools. The payload carries `hook_event_name` (the
Claude name), `session_id`, `tool_name`, `tool_input`, `tool_use_id`, and `cwd`;
tool-result events add `tool_output`, `tool_response`, and `is_error`.

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
the working directory set to `$CORTEX_HOME`, the payload delivered as JSON on
stdin, and stderr captured into the daemon log. `run.timeout` seconds is the
process limit — 30 by default, and session events use 60 unless the declaration
says otherwise.

What the bus does with stdout depends on `result`:

- `hook-result` — stdout is parsed as JSON and handed back to the caller. Thread
  lifecycle hooks use this to request a follow-up agent turn.
- `stdout-as-prompt` — trimmed stdout is used as a prompt. Session events use
  this to inject a turn.
- `none`, or omitted — output is discarded; the hook is fire-and-forget.

A hook that times out, exits non-zero, or writes unparseable output is logged
and skipped. It never fails the surrounding operation.

## Thread-template-scoped hooks

Some hooks belong to one thread template rather than to the whole system, so
templates keep their own hook block in
`$CORTEX_HOME/config/thread-templates/templates/<name>.json`:

```json
{
  "name": "example",
  "hooks": {
    "onEnd": {
      "command": "node $CORTEX_HOME/hooks/post-task-hook.mjs",
      "args": ["reviewer"],
      "timeout": 10000
    }
  }
}
```

`onStart`, `onTransition`, and `onEnd` correspond to `cortex:thread.start`,
`cortex:thread.transition`, and `cortex:thread.end`. They are dispatched through
the same bus as registry hooks, in the same emission, under the synthetic id
`template:<template>:<phase>`, and always with `hook-result` semantics. Two
details differ from registry entries: `timeout` here is in **milliseconds**
(default 30000), and `args` are passed as positional `$1`, `$2` to the command.
A caller that starts a thread programmatically can supply the same shape as
extra hooks for that run alone; those appear as `extra:<threadId>:<phase>`.

A thread hook controls what happens next by writing JSON to stdout:

```json
{
  "insertAgent": true,
  "profile": "__active__",
  "prompt": "Review the thread output and suggest next steps."
}
```

`insertAgent` spawns a temporary agent for the prompt. To route the prompt to an
agent already in the thread instead, name it:

```json
{
  "targetAgent": "reviewer",
  "prompt": "The planner finished. Here is additional context..."
}
```

`targetAgent` sends the prompt to that agent's persistent session; an optional
`directive` is prepended to the prompt in either mode.

## Session events and prompt injection

`cortex:session.new` fires before a session is torn down by `!new` or the "New"
status button, and `cortex:session.messageEnd` fires after each assistant turn.
Both are declared like any other hook; the shipped `session-new-hook`
declaration points at `new-session-hook.mjs` with `result` set to
`stdout-as-prompt`.

Beyond the JSON payload on stdin, session hooks receive `CORTEX_HOOK_CHANNEL`,
`CORTEX_HOOK_SESSION_ID`, `CORTEX_HOOK_SESSION_NAME`, `CORTEX_HOOK_TRIGGER`, and
`CORTEX_HOOK_EXECUTION_ID` in the environment. Non-empty stdout is injected as a
fresh agent turn — for `session.new` against the still-alive session on an
isolated session key that is closed afterwards, so the pre-close turn cannot
resurrect the old session under the channel; for `session.messageEnd` on the
channel itself, so the follow-up continues the live conversation and its output
threads under the reply that triggered it.

## The hook-bridge: blocking tool calls over HTTP

Two tool events need a human in the loop, which the agent process cannot do on
its own. `ask-user-question-hook.mjs` and `exit-plan-mode-hook.mjs` POST to the
server's webhook listener (`WEBHOOK_PORT`, default 3001) on
`/hook/ask-user-question` and `/hook/exit-plan-mode`, and block on the response.

On the server, `orchestration/routing/hook-bridge.ts` registers a pending
promise with a 30-minute TTL and publishes `ask-user.requested` or
`plan.submitted` on the event bus. The subscribers in
`hook-bridge-subscribers.ts` turn those into interactive Slack messages. When
the user clicks a button or submits the modal, the interaction handler resolves
the promise, the HTTP response returns to the waiting hook script, and the
script writes the answer to stdout — which the agent reads as the tool's
pre-execution result.

## Hook scripts

Scripts live in `$CORTEX_HOME/hooks/` and are ordinary Node.js `.mjs` files:
read JSON context from stdin, write JSON (or, for `stdout-as-prompt` hooks,
plain text) to stdout. The scripts shipped with Cortex are:

| Script | Used by | Purpose |
|---|---|---|
| `sensitive-file-edit.mjs` | `agent:pre-tool`, `Edit\|Write` | Performs the write directly so agent-config paths under protection can still be edited, then denies the built-in tool so it doesn't run twice |
| `tasks-yaml-guard.mjs` | `agent:pre-tool`, `Edit\|Write` | Denies edits to `TASKS.yaml` unless the current process holds the project lock |
| `ask-user-question-hook.mjs` | `agent:pre-tool`, `AskUserQuestion` | Forwards the question to the hook-bridge and blocks until the user answers |
| `exit-plan-mode-hook.mjs` | `agent:pre-tool`, `ExitPlanMode` | Forwards the plan to the hook-bridge and blocks until it is approved or rejected |
| `memory-ref-tracker.mjs` | `agent:post-tool`, `Read\|Grep` | Records memory-file accesses to `_meta/access-log.jsonl` |
| `rules-loader.mjs` | `agent:post-tool`, `Read\|Grep` | Injects scoped rules from `$CORTEX_HOME/rules/` when a matching path is read, once per session per rule |
| `session-activity-tracker.mjs` | `agent:post-tool`, `Read\|Edit\|Write\|Skill` | Appends activity records to `logs/session-activity/<session_id>.jsonl` |
| `cortex-md-injector.mjs` | `agent:post-tool` (`Read\|Edit`) and `agent:session-start` | Injects the CORTEX.md ancestor chain into agent context, deduplicated per session |
| `task-status-check.mjs` | `cortex:thread.end`, `{"source": "task-dispatch"}` | Checks whether a dispatched task was left in an unresolved state and asks the thread to close it out |
| `new-session-hook.mjs` | `cortex:session.new` | Recalls valuable information from the closing session and writes it to the context files |
| `post-task-hook.mjs` | Template `onEnd` hooks | Prompts the target agent to compound what it learned and commit |

The `PermissionRequest` auto-allow declaration uses `run.command` rather than a
script: a one-line `printf` that returns an allow decision for `Edit|Write`.
Access control for those tools is enforced by the pre-tool guards above.

## The cortex-hook CLI

`cortex-hook` inspects and operates the mounted hooks. Every command prints
JSON.

| Command | Flags | What it does |
|---|---|---|
| `cortex-hook list` | — | Lists every mounted hook as `id`, `event`, `enabled`, `source` (`managed`, `user`, or `template-scoped`) |
| `cortex-hook show` | `--id <id>` | Prints one complete declaration, including `source` |
| `cortex-hook enable` | `--id <id>`, `--dry-run` | Sets `enabled: true` in the declaration file, idempotently |
| `cortex-hook disable` | `--id <id>`, `--dry-run` | Sets `enabled: false` the same way |
| `cortex-hook test` | `--id <id>`, `--payload <file\|->` | Runs the hook once with the payload on stdin |

`--help` / `-h` works on the root command and on each subcommand.

```bash
cortex-hook list
cortex-hook show --id task-status-check
cortex-hook disable --id rules-loader --dry-run
cortex-hook test --id sensitive-file-edit --payload payload.json
cat payload.json | cortex-hook test --id sensitive-file-edit --payload -
```

`enable` and `disable` report `changed` so you can tell a real state change from
a no-op, and `--dry-run` adds a `would_set` block instead of writing. Disabling
a managed hook returns a warning: a later sync that ships a newer version of
that entry restores its shipped `enabled` state. Template-scoped hooks are
read-only — `enable` and `disable` reject them and list the registry ids you can
act on instead.

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
   next to the shipped entries — the numeric prefix places it after them:

   ```json
   {
     "id": "warn-sensitive-file",
     "event": "agent:pre-tool",
     "matcher": "Edit|Write",
     "run": { "script": "warn-sensitive-file.mjs", "timeout": 5 }
   }
   ```

   Leave `version` out. That marks the entry as yours, and hook syncs will never
   touch it.

3. Verify with `cortex-hook list` (the id appears with source `user`) and
   `cortex-hook test --id warn-sensitive-file --payload payload.json`.

An `agent:*`, `cc:*`, or `pi:*` hook applies to the next agent that spawns. A
`cortex:*` hook is picked up when the server next starts, because the bus
snapshots the registry at startup.

The same three steps cover server-side events — declare
`"event": "cortex:task.completed"` with a `matcher` such as
`{"project": "my-project"}` to run something whenever that project completes a
task.

## Reference tracking

The `memory-ref-tracker` hook implements automatic reference tracking for the
atomized memory system (see [memory.md](./memory.md) for the full architecture).
It records every Read and Grep access to experiment, knowledge, and pattern
files as one JSONL record of the accessed filename, the tool, and a timestamp:

```json
{"file": "<entry>.md", "tool": "Read", "ts": "2026-05-19T10:30:00.000Z"}
```

The log lives at `<project>/_meta/access-log.jsonl` and is auto-committed to git
after each write. Memory index regeneration reads it to compute access counts
(`refs`) and last-access timestamps (`last-ref`), which drive index sorting and
hot/cold classification.

## Debugging hooks

Start with `cortex-hook list` to confirm the hook is mounted and enabled, then
`cortex-hook test --id <id> --payload <file>` to run it in isolation with a
payload you control — that separates "the script is broken" from "the
declaration never matched". Hook execution and failures are logged to
`$CORTEX_HOME/logs/daemon.log`; anything a script writes to stderr is captured
there too.

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
- **Timeout** — raise `run.timeout` (seconds for registry entries, milliseconds
  for template hooks). The default is 30 seconds, or 60 for session events.
- **Script not found** — `run.script` resolves relative to `$CORTEX_HOME/hooks/`;
  absolute paths and `..` segments are rejected by the loader.
