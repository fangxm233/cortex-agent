---
name: thread
description: "Use when working with the Cortex thread system — understanding thread architecture, writing or modifying thread config (the per-entity JSON files under config/thread-templates/ — agents, templates, shells; plus transitions and hooks fields within templates), debugging thread execution, or when the user asks about multi-agent pipelines, agent orchestration, or the !thread command. Also trigger when modifying prompts/directives/, prompts/systemPrompts/, or prompts/promptTemplates/ files that feed into threads."
author: Cortex
version: 1.0.1
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
date: 2026-07-28
---

# Thread System

You are Cortex, working with the Thread multi-agent orchestration system.

## Arguments
$ARGUMENTS

---

## What Is a Thread?

A Thread is a **multi-agent orchestration work unit** — a managed pipeline that coordinates one or more Claude Code agent instances. Each thread has:

- A unique `ThreadId` (`thr_XXXXX`)
- A file-system workspace at `{REPO_ROOT}/tmp/threads/thr_XXXX/`
- A shared `artifact.md` file through which agents communicate
- A lifecycle with states: `running` → `completed` | `failed` | `cancelled` | `aborted`
- Cost tracking and step history

Threads can be **template-based** (following a predefined multi-agent pipeline) or **ad-hoc** (dynamically assembled by adding agents one at a time).

### Architecture Layer Diagram

```
Slack message / Scheduler / Task Dispatch
         │
   message-router.ts / scheduled-runner.ts
         │
   thread-manager.ts  (orchestration: create, step, transition, prompt assembly)
         │
   thread-runner.ts   (execution loop: run agents, hooks, Slack output)
         │
   runAgent() → claude-bridge.ts → Claude Code CLI process
         │
   VirtualSlackMessage → Slack
```

### Thread Lifecycle States

| State | Meaning | Terminal? |
|-------|---------|-----------|
| `running` | An agent step is in progress | No |
| `waiting` | Paused, waiting for user input | No |
| `completed` | All steps done | Yes |
| `failed` | Unrecoverable error | Yes |
| `cancelled` | User cancelled via `!thread cancel` | Yes |
| `aborted` | Agent self-aborted via the `thread_abort` tool | Yes |

---

## Control Plane (abort / split / wait) — DR-0015

Thread control is **out-of-band**: an agent signals its own thread by calling explicit MCP tools, NOT by writing markers into the artifact. The artifact is plain prose — text that merely mentions `[ABORT]` / `[SPLIT]` / `[WAIT_CHILDREN]` (e.g. "No [ABORT]", or a plan that says "if X then abort") triggers **nothing**. This eliminated the false-positive class behind the 2026-06-13 double-abort incident (DR-0015 problem 1).

### The three control tools (self-control of the caller's own thread)

All three target `CORTEX_THREAD_ID` (the thread you are running inside) — you never pass a thread id. Calling outside a thread is an error. After calling, end your step; the runner consumes the signal at the next step boundary.

- `thread_abort({ kind, diagnosis })` — terminate the thread early (terminal state `aborted`, distinct from `failed`). `kind ∈ {too-big, mis-scoped, blocked-external}`; `diagnosis` is required and becomes `thread.abortReason` (and, for a dispatch task, the task block reason). `too-big` / `mis-scoped` escalate to a re-planning manager; `blocked-external` escalates to a human.
- `thread_split({ subtasks })` — propose a decomposition of a dispatch task instead of doing it: the task is decomposed keep-parent (your task becomes the join node), unclaimed, and the children flow through the dispatch queue. `subtasks` is a typed array (decomposeTask shape).
- `thread_wait({ on_tasks?, on_threads? })` — suspend the thread until its awaited children finish; you are re-entered with their results once ALL are terminal.

### How Agents Know About the Control Plane

The protocol is **auto-injected** by the thread system — you do **not** need to add anything to an agent's directive. `buildStepPrompt` prepends a short `THREAD_PROTOCOL_PREAMBLE` block (defined in `agent-server/src/domain/threads/prompt-builder.ts`) to every step prompt of any thread that owns a workspace artifact. The preamble is skipped for auto-record / default / direct paths (no artifact) and on `--resume` of a persistent session (already delivered). Adding a new artifact-writing agent (a new file under `config/thread-templates/agents/`) automatically gets the control tools without editing its directive / promptTemplate / systemPrompt.

### When to Abort

Call `thread_abort` when:

- **Upstream is missing or malformed** — required inputs are absent or corrupt and cannot be produced by retrying.
- **Hardware / external resource unavailable** (`kind: blocked-external`) — target machine offline, GPU exhausted, external API permanently unreachable.
- **Specification unresolvable** (`kind: mis-scoped`) — the requirements contain a contradiction that cannot be decided autonomously.
- **Task is far bigger than described** (`kind: too-big`) — multiple independent units crammed together (prefer `thread_split` if you can already name the children).

Do **not** abort for: normal retry situations (use the `[REVISED]` convergence convention and let the reviewer loop handle it), minor warnings, or disagreements with the plan that can be recorded as feedback in the artifact.

### Execution Semantics

When the runner reads `metadata.pendingControl` after a step completes:

1. `abort` → thread status `aborted`, `abortReason` recorded; for a dispatch thread the owning task is blocked BEFORE the `onEnd` hook runs (DR-0015 problem 2). No further steps. `onEnd` still fires; `finalizeThread` flushes the artifact.
2. `split` → the runner breaks the loop leaving the signal in place; the dispatch path consumes `pendingControl.subtasks` and decomposes keep-parent.
3. `wait` → if live children remain the thread enters `waiting`; otherwise it continues.

The signal is cleared after consumption so an intent fires exactly once; the webhook rejects a second concurrent control on the same thread.

### Comparison with Other Terminators

| Mechanism | Who triggers it | Effect |
|-----------|-----------------|--------|
| `[APPROVED]` / `[IMPL-APPROVED]` | Reviewer agent (artifact text) | Convergence marker — reviewer approves, transition to next agent |
| `[REVISED]` | Doer agent (artifact text, after retry) | Signals retry complete; `output_not_contains` transition terminates loop |
| `thread_abort` tool | Any agent | Global abort — thread enters `aborted` terminal state, overrides all transitions |
| `!thread cancel` | User (Slack command) | Thread enters `cancelled` terminal state |

(`[APPROVED]` / `[REVISED]` remain in-band transition markers matched against agent output — they are evaluated by template `transitions`, a separate mechanism from the control plane.)

---

## Configuration File: thread-templates/

Location: `~/.cortex/config/thread-templates/` (a **directory**, one JSON file per entity).

Config is directory-based (DR-0017 D6 Phase 2.5): entities live one-file-each under three subdirectories, and **the filename without `.json` is the entity name**:

```
~/.cortex/config/thread-templates/
├── agents/<name>.json      # one agent definition per file
├── templates/<name>.json   # one pipeline template (or shell binding) per file
└── shells/<name>.json      # one shell definition (parameterized transition graph) per file
```

- **Loading priority:** the directory is used if it exists; otherwise the loader falls back to the legacy single file `config/thread-templates.json`. Shell bindings only resolve in the directory form (shells live under `shells/`).
- **One-time migration:** on startup a legacy single file (with no directory yet) is split into per-entity files and the original is renamed `thread-templates.json.migrated-bak` (preserved, never deleted; idempotent).
- **Defaults merge:** shipped defaults are a directory too, merged **per-file copy-if-missing** (never overwrites your files) so new default agents/templates/shells reach existing installs.
- **Hot-reload:** each entity subdirectory (`agents/`, `templates/`, `shells/`) and the `prompts/` directory are watched via `fs.watch` (300ms debounce); reload is fail-soft (a malformed file is skipped, not the whole table).

The two core entity kinds are `agents` (independent agent definitions) and `templates` (multi-agent pipelines, either full templates or shell bindings); `shells` are parameterized transition graphs the templates reuse.

### Agents Section

Each agent is an independent definition with its own identity, profile, and prompt configuration. Agents are referenced by templates but can also be used standalone via `!thread <agent-name> <message>`.

```json
{
  "agents": {
    "my-agent": {
      "name": "my-agent",
      "description": "Human-readable description",
      "profile": "execute",
      "persistSession": false,
      "directive": "You are a specialized agent for...",
      "promptTemplate": "{{input}}\n\nWrite your output to {{artifactPath}}.",
      "tools": "Agent,Bash,Edit,Glob,Grep,Read,Write"
    }
  }
}
```

#### Agent Fields Reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | string | Agent ID, must match the key in the agents map |
| `description` | No | string | Human-readable label shown in `!thread agents` |
| `profile` | Yes | string | Profile from `profiles.json`, or `"__active__"` for current runtime profile |
| `persistSession` | Yes | boolean | `true`: reuse Claude Code session across loop iterations. `false`: fresh session each time |
| `directive` | No | string | Role/identity text prepended to the prompt. Supports `file:filename.md` to load from `prompts/directives/` |
| `systemPrompt` | No | string | Full system prompt override via `--system-prompt` flag. Supports `file:filename.md` to load from `prompts/systemPrompts/` |
| `promptTemplate` | Yes | string | Handlebars-style template with variables. Supports `file:filename.md` to load from `prompts/promptTemplates/` |
| `claudeAgent` | No | string | Claude Code agent name, loaded via `--agent` flag from `.claude/agents/` |
| `outputStyle` | No | string | Injected via Claude CLI `--settings '{"outputStyle":"<value>"}'` |
| `tools` | No | string | Comma-separated tool list for `--tools` flag. Overrides the default tool set |
| `pluginDirs` | No | string[] | Plugin directories passed via `--plugin-dir` flags |

#### persistSession Explained

- `true` — The Claude Code process stays alive between loop iterations. The agent retains full conversation history. Use for agents that iterate on feedback (planner revising after review, writer revising after critique).
- `false` — A fresh Claude Code session is spawned each time the agent runs. Use for stateless evaluators (reviewer, QA) where independence from prior context is important.

#### file: Reference Mechanism

Directive, systemPrompt, and promptTemplate values starting with `file:` are loaded from corresponding subdirectories under `prompts/`:

```
prompts/
├── directives/       ← for directive: "file:director.md"
├── systemPrompts/    ← for systemPrompt: "file:web.md"
└── promptTemplates/  ← for promptTemplate: "file:my-template.md"
```

Loaded files are processed through `template-resolver.ts`, which supports:
- **YAML frontmatter** with `extends:` (template inheritance) and variable declarations
- **`@fill(name)` / `@endfill`** blocks to fill template slots
- **`@block(name)` / `@endblock`** for default content slots in base templates
- **`${var}` / `${var:-default}`** variable interpolation
- **`@if(var)` / `@if(!var)` / `@endif`** conditional sections
- **`{{runtime_vars}}`** (e.g., `{{currentDateTime}}`) pass through untouched for runtime resolution

### Templates Section

Templates define multi-agent pipelines by composing agents with transition rules.

```json
{
  "templates": {
    "my-pipeline": {
      "name": "my-pipeline",
      "description": "Description of what this pipeline does",
      "agents": ["agent-a", {"ref": "agent-b", "promptTemplate": "override..."}],
      "transitions": [
        {"from": "agent-a", "to": "agent-b", "condition": {"type": "always"}}
      ],
      "entryAgent": "agent-a",
      "maxTotalSteps": 6,
      "maxTotalCostUsd": 5.0,
      "hooks": {
        "onEnd": {
          "command": "node ~/.cortex/hooks/post-task-hook.mjs",
          "args": ["agent-a"],
          "timeout": 10000
        }
      }
    }
  }
}
```

#### Template Fields Reference

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `name` | Yes | string | Template ID, must match the key |
| `description` | Yes | string | Human-readable description |
| `agents` | Yes | TemplateAgentRef[] | Ordered list of agent references (string name or override object) |
| `transitions` | Yes | TransitionRule[] | Rules governing agent-to-agent transitions |
| `entryAgent` | Yes | string | Which agent starts the pipeline |
| `maxTotalSteps` | Yes | number | Hard cap on total agent steps |
| `maxTotalCostUsd` | No | number | Cost limit in USD. Pipeline stops when exceeded |
| `hooks` | No | ThreadHooks | Lifecycle hooks (onStart, onTransition, onEnd) |

#### Agent References in Templates

Templates reference agents in two ways:

**Simple reference** (string): Uses the agent definition as-is.
```json
"agents": ["planner", "reviewer"]
```

**Override reference** (object): Overrides specific fields for this template only.
```json
"agents": [
  {
    "ref": "planner",
    "promptTemplate": "Custom template for this pipeline...",
    "persistSession": true
  },
  "reviewer"
]
```

Override objects support: `ref` (required), `promptTemplate`, `directive`, `systemPrompt`, `persistSession`, `claudeAgent`, `outputStyle`, `tools`, `pluginDirs`.

### Shell Templates (shells/ + shell bindings)

When several pipelines share the same transition graph and differ only in which agents fill the roles, define the graph once as a **shell** (pure JSON in `shells/<name>.json`) and reference it from `templates/` with a small **shell binding**. The shell declares `params` and uses placeholders in its graph:

- `{param}` → the binding's value for that parameter (an agent name).
- `{param.entryStage}` → that agent's `entryStage`, resolved from the agents map.

Shell definition (`shells/worker-review.json` — the shipped generic produce-then-audit loop):

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
  "hooks": { "onEnd": { "command": "node ~/.cortex/hooks/post-task-hook.mjs", "args": ["{worker}"], "timeout": 10000 } }
}
```

Shell binding (`templates/doc-review.json`) — a template that just names the shell and its params:

```json
{
  "shell": "worker-review",
  "worker": "doc-writer",
  "reviewer": "doc-reviewer",
  "description": "Generic produce-then-audit for documents"
}
```

At load, the loader interpolates the placeholders and validates the result into a full template (here: `doc-writer` at its entry stage → `doc-reviewer` → `doc-writer:retry` until `[APPROVED]`). A validation failure (missing param, unknown placeholder, agent not found, agent missing `entryStage`, or a transition endpoint naming a stage the agent lacks) fails that one template with a logged error; an unknown shell name is fail-soft skipped — the rest of the config still loads. A binding may also set `maxTotalSteps` to override the shell's default budget.

---

## Prompt Template Variables

The `promptTemplate` field supports these variables, resolved at step execution time:

| Variable | Description |
|----------|-------------|
| `{{input}}` | The original user message that started the thread |
| `{{artifactPath}}` | Absolute path to the workspace's `artifact.md` file |
| `{{previousOutput}}` | The full output from the last completed agent step |
| `{{modifiedFiles}}` | Bullet list of files edited/written by the previous agent (from path-only session-activity logs) |
| `{{currentDateTime}}` | Current timestamp in Asia/Shanghai timezone |

Conditional blocks are supported:
```
{{#if previousOutput}}
Review feedback:
{{previousOutput}}
Please revise based on the feedback.
{{/if}}
```

Directive and systemPrompt fields also support `{{currentDateTime}}` and other system variables via `resolveSystemVars()`.

---

## Transition Rules

Transitions define how agents hand off to each other. Each rule has `from`, `to`, and a `condition`.

### Condition Types

| Type | Fields | Behavior |
|------|--------|----------|
| `always` | — | Always transition to the next agent |
| `convergence` | `marker`, `maxIterations` | Loop until `marker` string found in artifact content, or `maxIterations` reached |
| `output_contains` | `pattern` | Transition if the artifact content matches the regex `pattern` |
| `output_not_contains` | `pattern` | Transition if the artifact content does NOT match the regex `pattern` |

### Common Transition Patterns

**Linear pipeline** (A → B → C):
```json
"transitions": [
  {"from": "A", "to": "B", "condition": {"type": "always"}},
  {"from": "B", "to": "C", "condition": {"type": "always"}}
]
```

**Convergence loop** (A ↔ B until marker):
```json
"transitions": [
  {"from": "A", "to": "B", "condition": {"type": "always"}},
  {"from": "B", "to": "A", "condition": {"type": "convergence", "marker": "[APPROVED]", "maxIterations": 5}}
]
```

The convergence condition means: if `[APPROVED]` is NOT found in the artifact, loop back to A. If found (or maxIterations hit), the pipeline stops.

**Conditional branching** (B → C if approved, B → A if not):
```json
"transitions": [
  {"from": "A", "to": "B", "condition": {"type": "always"}},
  {"from": "B", "to": "C", "condition": {"type": "output_contains", "pattern": "\\[APPROVED\\]"}},
  {"from": "B", "to": "A", "condition": {"type": "output_not_contains", "pattern": "\\[APPROVED\\]"}}
]
```

Transitions are evaluated in order — the first matching rule wins.

---

## Hooks System

Templates can define lifecycle hooks that execute external scripts at key moments.

```json
"hooks": {
  "onStart": { "script": "path/to/script.mjs", "args": ["arg1"], "timeout": 30000 },
  "onTransition": { "script": "...", "timeout": 10000 },
  "onEnd": { "script": "...", "args": ["target-agent"], "timeout": 10000 }
}
```

| Hook | When | Use Case |
|------|------|----------|
| `onStart` | Before the first agent step | Setup, validation |
| `onTransition` | After each transition, before the next step | Intermediate processing |
| `onEnd` | After all steps complete | Cleanup, compound, git commit |

Hook scripts receive `HookContext` on stdin (JSON) and return `HookResult` on stdout (JSON):

**HookContext** (input):
```typescript
{
  threadId, templateName, phase, currentStepIndex,
  steps, activeAgent, previousAgent,
  artifactContent, userMessage, totalCostUsd
}
```

**HookResult** (output) — two modes:
1. `insertAgent: true` — Creates a temporary new agent to execute the prompt
2. `targetAgent: "slotId"` — Sends a prompt to an existing agent's persistent session (process alive → stdin, dead → `--resume`)

Example hook script (`post-task-hook.mjs`): Checks if `/compound-simple` should run and if there are uncommitted git changes, then sends a combined prompt to the worker agent's session.

---

## Agent Communication

Agents in a thread communicate through three mechanisms:

1. **Artifact file** (`{{artifactPath}}`): A shared `artifact.md` in the thread workspace. Agents read from and write to this file. This is the primary structured communication channel.

2. **Output passing** (`{{previousOutput}}`): The full text output of the previous agent step is available to the next agent via this variable.

3. **Modified files list** (`{{modifiedFiles}}`): A bullet list of files the previous agent edited/wrote, extracted from path-only session-activity JSONL logs.

For ad-hoc threads (no template), the previous agent's output is automatically injected into the next agent's prompt even without `{{previousOutput}}` in the template.

---

## Task Dispatch Integration

Tasks in TASKS.md use the `[template: <name>]` tag to specify which thread template to use when dispatched:

```markdown
- [ ] Run ablation study [template: <template-name>]
  Why: Need to isolate depth-sensor contribution
  Done when: Results in experiments/EXP-NNN.md
```

The `[template:]` tag is **required** for all dispatchable tasks. Tasks without it are flagged by the `task-parser.ts` lint check (`missing-template`).

Dispatch flow: `task-dispatcher.ts` selects a task → extracts template name → `createThread({templateName})` → `runThreadExec()`.

---

## Key Source Files

| File | Role |
|------|------|
| `~/.cortex/config/thread-templates/` | Agent + template + shell configuration (directory, one JSON file per entity under `agents/`, `templates/`, `shells/`) |
| `agent-server/src/thread-types.ts` | All TypeScript interfaces |
| `agent-server/src/thread-store.ts` | In-memory cache + threads.json persistence |
| `agent-server/src/thread-manager.ts` | Core orchestration (create, step, transition, prompt assembly) |
| `agent-server/src/thread-runner.ts` | Execution loop (run agents, hooks, Slack output) |
| `agent-server/src/template-resolver.ts` | `file:` reference expansion for prompts |
| `agent-server/src/message-router.ts` | Slack message → thread routing |
| `agent-server/src/scheduled-runner.ts` | Scheduler + dispatch → thread creation |
| `agent-server/src/task-dispatcher.ts` | Task selection and dispatch prompt building |
| `~/.cortex/hooks/post-task-hook.mjs` | onEnd hook for scheduler/worker templates |

---

## How to Add a New Agent

1. Add the agent definition as a new file `~/.cortex/config/thread-templates/agents/<name>.json` (the filename without `.json` is the agent name)
2. If using a `file:` directive, create the directive file in `prompts/directives/`
3. If using a `file:` systemPrompt, create it in `prompts/systemPrompts/`
4. Choose the right `profile` (plan/execute/qa/__active__)
5. Choose `persistSession` based on whether the agent needs to retain context across iterations
6. The config hot-reloads — no restart needed

## How to Add a New Template

1. Define any new agents needed as files under `~/.cortex/config/thread-templates/agents/`
2. Add the template as a file `~/.cortex/config/thread-templates/templates/<name>.json` (the filename without `.json` is the template name) with:
   - `agents`: list of agent refs (simple strings or override objects)
   - `transitions`: rules connecting agents
   - `entryAgent`: the starting agent
   - `maxTotalSteps`: safety cap
3. Optionally add `maxTotalCostUsd` for cost limits
4. Optionally add `hooks` for lifecycle automation
5. Test via `!thread <template-name> <test-message>` in Slack

## Common Patterns for New Templates

**Single-agent with hook** (like worker/scheduler):
```json
{
  "name": "my-task",
  "agents": ["my-agent"],
  "transitions": [],
  "entryAgent": "my-agent",
  "maxTotalSteps": 1,
  "hooks": { "onEnd": { "command": "node ~/.cortex/hooks/post-task-hook.mjs", "args": ["my-agent"], "timeout": 10000 } }
}
```

**Two-agent convergence loop** (doer ↔ checker iteration):
```json
{
  "name": "my-loop",
  "agents": ["doer", "checker"],
  "transitions": [
    {"from": "doer", "to": "checker", "condition": {"type": "always"}},
    {"from": "checker", "to": "doer", "condition": {"type": "convergence", "marker": "[PASS]", "maxIterations": 3}}
  ],
  "entryAgent": "doer",
  "maxTotalSteps": 8
}
```

**Linear pipeline with optional prompt overrides**:
```json
{
  "name": "my-pipeline",
  "agents": [
    {"ref": "scout", "promptTemplate": "Focus on {{input}}\n\nWrite findings to {{artifactPath}}."},
    "analyzer",
    "reporter"
  ],
  "transitions": [
    {"from": "scout", "to": "analyzer", "condition": {"type": "always"}},
    {"from": "analyzer", "to": "reporter", "condition": {"type": "always"}}
  ],
  "entryAgent": "scout",
  "maxTotalSteps": 4
}
```
