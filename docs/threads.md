# Cortex Thread System

The thread system is Cortex's multi-agent orchestration engine. A thread is a relay of focused agents — each with its own system prompt, tools, and plugins — passing a shared artifact file between them to accomplish complex, multi-step research work.

## Mental Model

A thread is like a relay race. Each agent (runner) picks up the baton (the `artifact.md` file), does its work, and hands off to the next agent based on transition rules. The artifact file is the shared memory — agents write their findings to it, and subsequent agents read what came before.

Threads are defined by **templates** under `~/.cortex/config/thread-templates/` (see [Configuration File](#configuration-file)). Threads are often launched by the task dispatch system — see [tasks.md](./tasks.md) for how tasks trigger thread execution. A template specifies: which agents participate, in what order, with what transition logic, and what lifecycle hooks fire between steps.

## Configuration File

The thread system is configured under `~/.cortex/config/thread-templates/` (read from `$CORTEX_HOME/config/thread-templates/`) — a **directory** holding one JSON file per entity, split across three subdirectories:

```
~/.cortex/config/thread-templates/
├── agents/<name>.json      # one agent definition per file
├── templates/<name>.json   # one pipeline template (or shell binding) per file
└── shells/<name>.json      # one shell definition (parameterized transition graph) per file
```

Each file holds a single entity, and **the filename (without `.json`) is the entity name**. For `agents/`, the JSON's `name` field must match the filename or the file is skipped with a warning; for `templates/`, a `name` field is optional but if present must match the filename.

**Loading priority.** If the `config/thread-templates/` directory exists, it is used. Otherwise the loader falls back to the legacy single file `config/thread-templates.json` (backward compatibility). Note that shell bindings only resolve in the directory form — shell definitions live under `shells/`, so a legacy single-file config cannot expand them.

**One-time migration.** On startup, if a legacy `config/thread-templates.json` exists and the directory does not, the server splits the single file into per-entity files under the directory and renames the original to `thread-templates.json.migrated-bak` (the original is preserved, never deleted). The migration is idempotent — it is a no-op once the directory exists.

**Defaults merge.** The shipped defaults are a directory too. On startup they are merged into your config with **per-file copy-if-missing** semantics (aligned with plugin-sync): a default agent/template/shell file you do not yet have is copied in; files you already have are never overwritten. This lets new default entities (for example a newly shipped shell definition) reach existing installs without clobbering local edits.

**Hot-reload.** Each entity subdirectory (`agents/`, `templates/`, `shells/`) is watched, along with any prompt files in the `prompts/` directory. Changes are detected via `fs.watch`, debounced (300ms), and the whole config is reloaded without restarting the server. Reload is fail-soft: a single malformed JSON file is skipped with a warning rather than clearing the whole table. A notification is sent to the admin Slack channel on reload.

### Editing Templates

These files can be edited by hand, and hot-reload will pick the change up. They can also be edited from the desktop app under **Settings → Thread templates**, which is the safer route because it validates before it writes.

The panel is a master-detail editor: the list on the left carries every agent, template and shell with a badge marking anything that currently fails validation, and the pane on the right holds the entity's raw JSON alongside two read-only tabs. **Validation** lists errors and warnings with the field each one came from; **References** shows the file path on disk, which templates depend on this entity, how many live threads are running on it and how many open tasks name it.

Validation runs on save and on demand, and it judges the candidate against the world the save would produce rather than the one it replaces — so a template may name an agent that is being created in the same edit. Errors block the write; warnings (an unrecognized field, most often) are reported and let it through. The check that matters most is the impact pass: saving an agent re-validates every template that uses it, which is what catches the class of edit that would otherwise leave a running thread with nowhere to step. Because the executor re-reads transitions and prompts on *every* step, a bad edit does not fail loudly at launch — it stalls a thread mid-flight.

Three guards sit on the write path. A save to an entity with live threads on it asks for a second click, since those threads will pick the change up on their next step. Deleting is refused outright while another template still references the entity. And a save carries the hash of the body the editor loaded, so an edit made against a stale view — someone else's save, or your own hand-edit landing through hot-reload — is rejected as a conflict rather than silently overwriting it.

Renaming is not offered: the filename *is* the identity, and a rename would orphan every reference to the old name. Duplicate to the new name and delete the old one, which forces the dependent templates to be updated in between.

Entities are labelled by origin. **stock** is byte-identical to the file Cortex ships, **modified** is a shipped file you have since changed, and **custom** is entirely your own. Editing a stock entity forks it permanently — the defaults merge is copy-if-missing, so your version will never be overwritten by an upgrade, and equally will never pick up improvements to the shipped one. The config directory is plain JSON and worth keeping under git; that, not a backup file, is the undo.

### Agent Definitions

Each file under `agents/` defines one agent — an independent entity with its own identity, tools, and prompt. The file holds the agent object itself, and its `name` must match the filename.

`agents/planner.json`:

```json
{
  "name": "planner",
  "description": "Plans the research approach",
  "profile": "claude-sonnet",
  "persistSession": false,
  "directive": "You are a research planner. Break down problems into testable hypotheses.",
  "promptTemplate": "file:planner-prompt.md",
  "tools": "Agent,AskUserQuestion,Bash,Read,Grep,Glob,Write,Edit,WebSearch,WebFetch,Skill",
  "pluginDirs": ["plugins/cortex-common", "plugins/cortex-surveyor"]
}
```

**Agent definition fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent ID — required, and must equal the filename (`agents/<name>.json`) |
| `profile` | string | Profile name from `profiles.json`, or `"__active__"` to use the current runtime profile |
| `persistSession` | boolean | `true`: reuse the same LLM session across iterations (preserves conversation context). `false`: fresh session each step |
| `directive` | string? | Agent role/identity, prepended to the prompt. Supports `file:filename.md` references |
| `systemPrompt` | string? | Full system prompt override. Supports `file:` references |
| `promptTemplate` | string? | Template with `{{input}}`, `{{artifactPath}}`, `{{previousOutput}}`, `{{modifiedFiles}}`, `{{currentDateTime}}` variables. Supports `file:` references |
| `claudeAgent` | string? | Claude Code agent name (`--agent` flag, loads from `.claude/agents/`) |
| `outputStyle` | string? | Claude Code output style |
| `tools` | string? | Comma-separated tool list (overrides defaults) |
| `pluginDirs` | string[]? | Plugin directories to load (`--plugin-dir` flags) |

### Multi-Stage Agents

An agent can declare multiple **stages** via the `stages` field. When stages are present, `promptTemplate` is ignored — the engine selects the appropriate stage's prompt for each step based on the transition target.

`agents/coder.json`:

```json
{
  "name": "coder",
  "profile": "claude-sonnet",
  "persistSession": true,
  "entryStage": "implement",
  "stages": {
    "implement": {
      "promptTemplate": "You are implementing the plan. Write code to {{artifactPath}}.",
      "description": "Write the implementation"
    },
    "review": {
      "promptTemplate": "You are reviewing the code in {{artifactPath}}. Check for correctness.",
      "continuesSession": true,
      "description": "Review the implementation"
    }
  },
  "pluginDirs": ["plugins/cortex-coder"]
}
```

When `continuesSession: true` is set on a stage, and the agent has a persistent session that is being resumed, the engine sends only the stage-specific incremental prompt — skipping the directive, protocol preamble, and automatic `previousOutput` injection.

### File References

Fields that accept `file:filename.md` syntax load their content from `prompts/<subdir>/filename.md`:

| Field | Subdirectory |
|-------|-------------|
| `directive` | `prompts/directives/` |
| `promptTemplate` | `prompts/promptTemplates/` |
| `systemPrompt` | `prompts/systemPrompts/` |

The template system supports a YAML-frontmatter-based format with `extends:` (inheritance), `@fill(name)`/`@endfill` named blocks, `@block(name)`/`@endblock` template blocks, `${var}` / `${var:-default}` variable interpolation, and `@if(var)`/`@endif` conditionals.

## Templates

Templates compose agents into multi-step pipelines. Each file under `templates/` holds one template object.

`templates/coder-review.json`:

```json
{
  "name": "coder-review",
  "description": "Implement a feature then review it",
  "agents": ["planner", "coder", "reviewer"],
  "transitions": [
    {"from": "planner", "to": "coder:implement", "condition": {"type": "always"}},
    {"from": "coder:implement", "to": "coder:review", "condition": {"type": "always"}},
    {"from": "coder:review", "to": "reviewer", "condition": {"type": "always"}}
  ],
  "entryAgent": "planner",
  "maxTotalSteps": 10,
  "maxTotalCostUsd": 5.00,
  "hooks": {
    "onEnd": {
      "command": "node hooks/post-task-hook.mjs",
      "timeout": 30000
    }
  }
}
```

**Template fields:**

| Field | Type | Description |
|-------|------|-------------|
| `name` | string? | Optional; if present it must equal the filename (`templates/<name>.json`). The filename is the template ID used in `!thread <name>` and task dispatch |
| `agents` | TemplateAgentRef[] | Ordered list of participating agents |
| `transitions` | TransitionRule[] | Rules governing when to move from one agent to the next |
| `entryAgent` | string | The first agent to run |
| `entryStage` | string? | Which stage to enter on the first step (defaults to agent's `entryStage`) |
| `maxTotalSteps` | number | Hard limit on total agent steps |
| `maxTotalCostUsd` | number? | Cost limit in USD |
| `hooks` | ThreadHooks? | Lifecycle hooks (onStart, onTransition, onEnd) |

### Agent References in Templates

Templates reference agents either by name (as a string) or with per-template overrides (as an object):

```json
// Simple reference — use agent as defined
"agents": ["planner", "reviewer"]

// With overrides — customize the agent for this template
"agents": [
  {"ref": "planner"},
  {"ref": "coder", "promptTemplate": "file:special-coder-prompt.md", "tools": "Read,Write,Edit"}
]
```

Override fields: `promptTemplate`, `directive`, `systemPrompt`, `persistSession`, `claudeAgent`, `outputStyle`, `tools`, `pluginDirs`.

### Shell Templates

Pipelines that share the same transition graph and differ only in which agents fill the roles are defined once as a **shell** — a parameterized transition graph stored as pure JSON in `shells/<name>.json` — and referenced by lightweight **shell bindings** in `templates/`.

A shell declares its parameters and uses placeholders in the graph:

- `{param}` — substituted with the binding's value for that parameter (an agent name).
- `{param.entryStage}` — substituted with that agent's `entryStage`, resolved from that agent's definition under `agents/`.

For example, the shipped `worker-review` shell (`shells/worker-review.json`) — a generic produce-then-audit loop:

```json
{
  "params": ["worker", "reviewer"],
  "agents": ["{worker}", "{reviewer}"],
  "transitions": [
    { "from": "{worker}:{worker.entryStage}", "to": "{reviewer}", "condition": { "type": "always" } },
    { "from": "{reviewer}", "to": "{worker}:retry", "condition": { "type": "convergence", "marker": "[APPROVED]", "maxIterations": 1 } },
    { "from": "{worker}:retry", "to": "{reviewer}", "condition": { "type": "output_not_contains", "pattern": "\\[REVISED\\]" } }
  ],
  "entryAgent": "{worker}",
  "entryStage": "{worker.entryStage}",
  "maxTotalSteps": 4,
  "hooks": {
    "onEnd": { "command": "node ~/.cortex/hooks/post-task-hook.mjs", "args": ["{worker}"], "timeout": 10000 }
  }
}
```

A template then binds it by naming the shell and its parameters (`templates/doc-review.json`):

```json
{
  "shell": "worker-review",
  "worker": "doc-writer",
  "reviewer": "doc-reviewer",
  "description": "Generic produce-then-audit for documents"
}
```

At load time the engine interpolates the placeholders and validates the result, producing a full template equivalent to writing the graph out by hand (here: `doc-writer` at its entry stage → `doc-reviewer` → `doc-writer:retry` until `[APPROVED]`). Validation errors — a missing parameter, an unknown placeholder, a referenced agent that does not exist, an agent missing its `entryStage`, or a transition endpoint naming a stage the agent lacks — fail that one template at load with a logged error; an unknown shell name is fail-soft skipped. In every case the rest of the config still loads.

**Shell definition fields (`shells/<name>.json`):**

| Field | Type | Description |
|-------|------|-------------|
| `params` | string[] | Required binding parameter names |
| `agents` | string[] | Agent slots as placeholder strings (e.g. `"{worker}"`) — declares which params name agents |
| `transitions` | TransitionRule[] | Transition graph with placeholder endpoints |
| `entryAgent` | string | Entry agent placeholder |
| `entryStage` | string? | Entry stage placeholder |
| `maxTotalSteps` | number | Default step budget (a binding's `maxTotalSteps` overrides it) |
| `maxTotalCostUsd` | number? | Cost limit in USD |
| `hooks` | ThreadHooks? | Lifecycle hooks (placeholders allowed in args) |

**Shell binding fields (a template that references a shell):**

| Field | Type | Description |
|-------|------|-------------|
| `shell` | string | Name of the shell to expand |
| `<param>` | string | One value per shell parameter (e.g. `worker`, `reviewer`) — the agent name that fills that role |
| `description` | string? | Human-readable description (carried onto the expanded template) |
| `maxTotalSteps` | number? | Override the shell's default step budget |

## Transitions

Transitions determine how the thread moves from one agent to the next. They are evaluated after each agent step completes.

### Transition Endpoint Syntax

Endpoints use the syntax `"agent"` or `"agent:stage"`. A bare agent name matches any stage of that agent. An `agent:stage` endpoint matches only that specific stage.

### Condition Types

| Type | Behavior | Parameters |
|------|----------|------------|
| `always` | Always transition | None |
| `convergence` | Loop until a marker string appears in the artifact output, or until `maxIterations` is reached | `marker` (string to find), `maxIterations` (max loops, default 3) |
| `output_contains` | Transition if the artifact output matches a regex pattern | `pattern` (regex string) |
| `output_not_contains` | Transition if the artifact output does NOT match a regex pattern | `pattern` (regex string) |

### Evaluation Order

Transitions are evaluated in the order they appear in the template. The **first matching rule wins**. If no rule matches, the thread stops (terminal state: `no_matching_transition`).

A rule's `from` endpoint is matched against the last completed step. Only rules whose `from` matches the last step's agent (and optionally stage) are considered.

### Convergence Example

```json
{
  "from": "coder:implement",
  "to": "coder:review",
  "condition": {
    "type": "convergence",
    "marker": "[IMPLEMENTATION COMPLETE]",
    "maxIterations": 5
  }
}
```

This means: after `coder:implement` runs, check if the artifact contains `[IMPLEMENTATION COMPLETE]`. If it does, transition to `coder:review`. If not, loop back to `coder:implement`. If it loops 5 times without the marker, stop with `max_iterations`.

### Template Limits

Two hard limits are checked before evaluating any transitions:

- `maxTotalSteps` — if the thread has reached this many total steps, stop with `max_iterations`
- `maxTotalCostUsd` — if the accumulated cost exceeds this, stop with `cost_limit`

## Thread Lifecycle

### States

A thread moves through these states during its lifetime:

```
running → completed   (all steps finished successfully)
running → failed      (unrecoverable error)
running → cancelled   (user cancelled via !cancel or button)
running → aborted     (agent self-aborted via the thread_abort tool)
running → waiting     (waiting for user input — Phase 6 buffering)
```

Terminal states: `completed`, `failed`, `cancelled`, `aborted`.

### Agent-Initiated Control (abort / split / wait)

Thread control is out-of-band: an agent signals its own thread by calling the `thread_abort`, `thread_split`, or `thread_wait` MCP tools, never by writing markers into the artifact (text mentioning those keywords in the artifact does nothing). The tool writes a structured `metadata.pendingControl` on the agent's own thread; the runner reads it after every step completion, with **higher priority than all transition rules**. `thread_abort({ kind, diagnosis })` immediately terminates the thread with status `aborted` (but `onEnd` hooks still fire); `thread_split({ subtasks })` proposes a decomposition of the owning dispatch task; `thread_wait` suspends until awaited children finish.

### Suspension and Wake-up (thread_wait)

A suspended manager waits on its child tasks (and any child threads). Calling `thread_wait` without `on_tasks` or `on_threads` infers all live linked children. Supplying either parameter switches to explicit override mode: only IDs listed in the supplied arrays are awaited, and an omitted array is treated as empty. Explicit IDs must identify live linked children; duplicate, missing, unrelated, and terminal IDs are ignored. Empty arrays therefore leave nothing to await and the thread continues.

Each child that completes or blocks is delivered into the manager's `pendingMessages` as a result or escalation notice, and the manager is re-entered once nothing is left to wait on. Delivery is event-driven (`task.completed` / `task.blocked`, verified against `TASKS.yaml` before delivery), backed by two safety nets: a periodic disk-driven sweep (every 60 seconds, configurable via the `waitingSweepMs` key in [`config/settings.json`](./configuration.md#configsettingsjson); the legacy `CORTEX_WAITING_SWEEP_MS` variable is still read as a deprecated fallback) that reconciles every waiting manager against on-disk task state, and a startup recovery pass that re-delivers results that turned terminal while the server was down. Open child tasks survive restarts and stay awaited.

Blocking a task does not cascade to its dependents, so a wait set can reach a state where every remaining awaited task depends — directly or transitively — on a blocked task and can never start. The wake path detects this stall and wakes the manager with a deadlock notice naming the stuck tasks and their blockers; the manager is expected to unblock, re-plan the decomposition, or escalate via `thread_abort`. Each distinct stall wakes the manager exactly once — an unchanged stall never re-wakes it.

### thread_wait Checkpoint Gate (DR-0017)

Before a manager suspends via `thread_wait`, it must leave a fresh checkpoint for its (possibly rotated) next incarnation. The runner enforces this with a **checkpoint gate**:

- On `thread_wait`, the gate compares the artifact's **current content hash** against the hash recorded at the **start of the current step**. If the artifact is **unchanged** since step start, `thread_wait` is **rejected**; if it **changed**, the wait is allowed.
- The comparison uses a **content hash, not mtime** — a bare `touch` cannot bypass it.
- The baseline hash is recorded at thread creation (the initial/inherited artifact state) and again at the end of every step, so the gate covers both the first step and every re-entry.
- **Exemptions**: `thread_abort` and `thread_split` are exempt — escalation must never be blocked. The gate applies only to threads that hold an `artifactPath`, and it **fails open** when no baseline was recorded.

The checkpoint the manager writes always covers four sections: **current delegations & their acceptance criteria**, **decisions made** (an append-only log), **remaining plan**, and **assumptions**.

When the gate rejects a wait, it returns:

> `checkpoint gate (DR-0017): your artifact has not been updated during this step. Before suspending, write your checkpoint into the artifact — current delegations & their acceptance criteria, decisions made, remaining plan, assumptions — then call thread_wait again.`

### Execution Loop

The main execution loop in `runner.ts` runs as follows:

1. **onStart hook**: Fire before the first step (template hook first, then caller's extraHooks)
2. **Loop**:
   a. Resolve the next step (which agent, which stage)
   b. Build the step config (prompt, session, profile, execution registry entry)
   c. Set up streaming callbacks (assistant message aggregation, tool traces)
   d. Execute the agent (spawn LLM process, await result)
   e. Record step outcome (persist to thread store, register session, finalize execution)
   f. Read metadata.pendingControl (abort / split / wait) written by the control tools
   g. Evaluate transitions (first matching rule wins, or stop)
   h. **onTransition hook**: Fire between steps (if transitioning)
3. **onEnd hook**: Fire after the main loop completes
4. Mark thread as completed (if still running)

## Lifecycle Hooks

Hooks are shell commands executed at specific points in the thread lifecycle. They receive context as JSON on stdin and can return instructions as JSON on stdout. Thread hooks are one of three hook subsystems — see [hooks.md](./hooks.md) for the full hook architecture, including agent-level and session-level hooks.

### Hook Points

| Hook | When it fires | Context |
|------|--------------|---------|
| `onStart` | Before the first agent step | `{ threadId, templateName, phase: "start", steps: [], activeAgent, artifactContent, userMessage, totalCostUsd }` |
| `onTransition` | After each transition, before the next step | Same as above, plus `previousAgent` identifying the agent that just completed |
| `onEnd` | After all steps complete, before the thread is marked done | Same as above, with final artifact content and completed steps |

### Hook Configuration

```json
{
  "onEnd": {
    "command": "node hooks/post-task-hook.mjs",
    "args": ["--project", "nimbus"],
    "timeout": 30000
  }
}
```

- `command` — full shell invocation (interpreter must be included: `node ...`, `bash ...`, etc.)
- `args` — positional arguments passed as `$1`, `$2`, ... via `sh -c 'cmd "$@"'`
- `timeout` — execution timeout in milliseconds (default: 30000)

### Hook Return Values

Hooks return JSON on stdout to control what happens next:

**Insert a temporary agent:**
```json
{
  "insertAgent": true,
  "prompt": "Run post-task cleanup: verify all tests pass",
  "profile": "claude-haiku",
  "directive": "You are a cleanup agent"
}
```
This creates a new temporary agent that runs the given prompt, then the thread continues normally.

**Target an existing agent's session:**
```json
{
  "targetAgent": "reviewer",
  "prompt": "Double-check the results in the artifact against the original requirements"
}
```
This sends the prompt to the `reviewer` agent's persistent session (via stdin if the process is still alive, or `--resume` if dead). `targetAgent` takes priority over `insertAgent`.

### Hook Execution Order

Template hooks fire first, then the caller's `extraHooks` (injected by scheduler/dispatch) at the same phase. Both use identical execution semantics. ExtraHooks are not persisted to the ThreadRecord — they are valid only for the current `runThread()` invocation.

## Workspace and Artifact

Each thread gets an isolated workspace on the filesystem:

```
tmp/threads/thr_a1b2c3d4/
├── artifact.md        # The shared artifact — agents read and write this
└── ...                # Any other files agents create
```

The artifact path is available to all agents via the `{{artifactPath}}` template variable. Agents communicate by reading what previous agents wrote and appending their own findings.

Agents can also identify files modified by previous agents:
- `{{previousOutput}}` — the complete output from the last completed step
- `{{modifiedFiles}}` — list of files edited by the previous agent (extracted from path-only session activity logs)

### Task-Keyed Manager Artifact (DR-0017)

Most threads keep their artifact in the **ephemeral thread workspace** shown above (`tmp/threads/{threadId}/artifact.md`), addressed by thread id and deleted on thread cleanup. A **manager thread** is different: it owns a composite task node and keeps its artifact at a **task-keyed** path, addressed by the owning task id rather than the thread id:

```
context/projects/{project}/manager/{taskId}/artifact.md
```

This artifact is **durable**. It survives thread cleanup, server restarts, and manager replacement/rotation, and is git-versioned with the context repo (every checkpoint accrues version history) — in contrast to the ephemeral `tmp/threads/{threadId}/artifact.md` workspace, which is discarded when the thread is cleaned up. It is set at dispatch time — the manager thread's `artifactPath` points at this task-keyed path — so `{{artifactPath}}`, artifact reads, and the [checkpoint gate](#thread_wait-checkpoint-gate-dr-0017) all operate on it unchanged, and workspace cleanup never touches it.

Its role is **rehydration memory**: a fresh manager incarnation (after rotation or a crash) inherits the previous incarnation's checkpoint from this file, so managers are expected to write it such that a stranger could continue the task from it alone. The manager-node concept and its acceptance ledger are documented in [tasks.md](./tasks.md).

## Thread Commands

### Starting a Thread

```
!thread coder-review Implement user authentication for the API
!thread researcher Survey recent papers on grasp planning
```

The first word after `!thread` is the template name (or agent name for single-agent execution). The rest is the user message passed to the first agent.

### Adding an Agent

```
!thread add reviewer
!thread add critic Please focus on security implications
```

This dynamically adds an agent to an existing thread. The thread must be completed or waiting (not currently running). If the thread was an auto-record (no filesystem workspace), a workspace is created lazily.

### Other Thread Commands

| Command | Description |
|---------|-------------|
| `!thread list` | List active threads |
| `!thread status [id]` | Show thread status and steps |
| `!thread cancel [id]` | Cancel a running thread |
| `!thread agents` | List available agents |
| `!thread templates` | List available templates |

## Thread Types

Cortex uses three types of thread records internally:

| Type | templateName | Workspace | Used by |
|------|-------------|-----------|---------|
| **Template thread** | Actual template name | Yes | `!thread <template>`, task dispatch |
| **Default thread** | `"default"` | Yes | Single-agent messages (the normal chat path) |
| **Auto thread** | `null` | No (initially) | `!thread add` chaining from single-agent runs |

The distinction matters because the runner treats default threads differently: they run exactly one step (no transitions), use the channel's existing session, and forward streaming output directly to the user.

## Thread Record

Each thread's full state is persisted in `~/.cortex/data/threads.json` as a `ThreadRecord`:

| Field | Description |
|-------|-------------|
| `id` | Thread ID (`thr_<8 hex>`) |
| `status` | Current lifecycle state |
| `channel` | Slack channel ID |
| `templateName` | Template used (null for ad-hoc) |
| `userMessage` | The original user message |
| `workspacePath` / `artifactPath` | File paths for the shared artifact |
| `agents` | Map of agent slots with their state (sessionId, status, persistSession) |
| `activeAgent` / `activeStage` | Which agent and stage runs next |
| `steps[]` | Recorded execution history per step (agent, stage, cost, duration, output) |
| `iterationCounts` | Track convergence loop counts per transition edge |
| `totalCostUsd` | Cumulative cost across all steps |
| `metadata` | Caller-provided context: scheduleTaskId, trigger, project, pendingMessages |
| `abortReason` | Reason if agent self-aborted |

Old threads are cleaned up on startup: threads older than 7 days are removed (24 hours for auto-records without workspaces).

## Prompt Variables

Agent prompts support template variables that are resolved at runtime:

| Variable | Description |
|----------|-------------|
| `{{input}}` | The user message (for the first step) or the previous agent's output |
| `{{artifactPath}}` | Absolute path to `artifact.md` |
| `{{previousOutput}}` | Full output from the last completed step |
| `{{modifiedFiles}}` | Files edited by the previous agent |
| `{{currentDateTime}}` | Current date and time in ISO format |

## Plugin Loading

Each agent definition specifies which plugin directories to load via `pluginDirs`. Plugins are resolved relative to `DATA_DIR` (default: `~/.cortex/`). For example, `plugins/cortex-coder` resolves to `~/.cortex/plugins/cortex-coder/`.

The plugin directories are passed to the LLM backend as `--plugin-dir` flags (Claude Code) or `--skill` flags (PI). The backend then scans for `SKILL.md` files and makes them available as invocable skills. See [skills-and-plugins.md](./skills-and-plugins.md) for the full skill and plugin system.

## Manager Session Rotation & Rehydration (DR-0017)

A manager thread is long-lived: it accumulates context across many wake-ups as its children run. To keep that context clean, DR-0017 **rotates the manager's LLM session** periodically, relying on the durable [task-keyed artifact](#task-keyed-manager-artifact-dr-0017) and its acceptance ledger (see [tasks.md](./tasks.md)) to carry state across the boundary.

- **Trigger**: checked at the resume chokepoint, just before re-entering a suspended manager. When `steps.length - rotationBaseStepIndex >= managerRotateSteps` (the `managerRotateSteps` key in [`config/settings.json`](./configuration.md#configsettingsjson), **default 10**; the legacy `CORTEX_MANAGER_ROTATE_STEPS` variable is still read as a deprecated fallback), the session rotates. Only **manager (task-artifact) templates** rotate — ordinary threads never do.
- **Rotation action**: clear every agent slot's `sessionId` (so the next step runs on a **fresh LLM session**, which naturally re-injects the full manager directive and the original task contract prompt), reset `rotationBaseStepIndex` to the current step count, and enqueue a **rehydration notice** for the fresh incarnation.
- **Rehydration notice**: it instructs the fresh incarnation to (1) **read its artifact first** — the file holds the predecessor's checkpoint; (2) **reconcile the task tree** (e.g. `cortex-task tree --task-id <id>`); and (3) **verify pending ledger deliveries** — child results still awaiting this manager's verdict must each be checked against their `done-when` before being trusted. It also tells the incarnation **not** to redo completed work or re-litigate recorded decisions, but to continue from the remaining plan.
- Rotation is a **deliberate kill test**: it is isomorphic to disaster/crash recovery — the fresh incarnation is rehydrated purely from durable state. It **fails open**: a rotation failure is non-fatal (the resume proceeds on the old session), and non-manager threads never rotate.

## Thread Cleanup

When a thread completes, fails, or is cancelled:

- The agent handle is removed from `RunningExecutions`
- Thread-specific sessions (keyed by `thr:<threadId>:`) are closed
- The thread store is flushed to disk

On server startup, any threads left in `running` status are marked as `failed` to prevent stale state.
