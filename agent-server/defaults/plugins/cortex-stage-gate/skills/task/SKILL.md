---
name: task
description: "MUST Use when adding, editing, querying, or managing cortex tasks — includes the execution-form triage (inline vs Agent-tool subagent vs task vs manager), task creation conventions (format, tagging, decomposition rules). MUST use before using cortex-task CLI."
author: Cortex
version: 2.1.2
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
date: 2026-07-31
---

# Task

You are Cortex, managing the TASKS.yaml task system.

## Arguments
$ARGUMENTS

The task system has a single canonical CLI: `cortex-task`
(source: `agent-server/src/domain/tasks/system/task-cli.ts`). Both read and write
operations live behind subcommands. Run `cortex-task --help` for
the full reference. Use this CLI as the source of truth for task operations
instead of manually editing `TASKS.yaml` when a canonical command exists.

---

## Step 0 — Choose the Execution Form (not every job is a task)

Creating a task dispatches a full thread pipeline (agents, artifact, review, callbacks,
queue latency). That machinery buys durability and independent verification — and costs
tokens, wall time, and tree depth. Match the form to the work BEFORE reaching for
`cortex-task add`:

| Work shape | Form | Why |
|---|---|---|
| Minutes-level, verifiable on the spot (query state, read code, small edit + check) | **Do it inline** | Delegation overhead exceeds the work |
| Small scoped unit whose result YOU consume immediately: a verification run, recon/search, log audit, one-shot analysis, scratch build | **Harness `Agent` tool (subagent)** | In-session, no queue, no thread; it is available in agent sessions and NOT forbidden; you audit the output yourself |
| A persistent, independently verifiable unit: needs the dispatch queue, a review pipeline, GPU scheduling, or must survive your session | **Leaf task** — `cortex-task add` + a worker review template | Thread machinery earns its cost |
| Composite: 2+ units needing coordination / acceptance / rework loops | **Manager task** — `--template manager` | Resident join node decomposes just-in-time and verifies children |

Rules that fall out of this ladder:

- **A verification step is NOT a reason to create a task.** When you (manager or worker)
  need to check something — re-derive a metric, audit a session log, probe an environment,
  smoke-test an output — spawn a subagent with the `Agent` tool and audit its answer
  yourself. Create a validation *task* only when the validation must itself exercise the
  thread machinery end-to-end (e.g. verifying a thread directive/pipeline behavior).
- **"Self-execute + verify" is a LEAF, not a composite.** A single unit of work plus its
  own verification does not justify a manager node. Do the work; verify via subagent. If
  the verification genuinely requires a dispatched child task, `cortex-task spawn` +
  `thread_wait` also works from worker templates (the wait/wake machinery is
  template-agnostic) — becoming a manager is not the price of waiting once.
- **The `default` / `scheduler` templates remain forbidden for task creation** (rejected at
  creation time). The escape hatch for small unreviewed work is the `Agent` tool in your
  own session — not a bare, unaudited thread.

---

## Canonical CLI Usage

### Read (no mutation)

```bash
cortex-task --help
cortex-task list                                  # actionable, sorted by project priority
cortex-task list --all --json                     # all tasks (incl. completed) as JSON
cortex-task stats                                 # supply statistics per project
cortex-task query --project <project> [--status <status>] [--priority <p>] [--text <s>] [--task-id <id>] [--has-deps] [--no-deps] [--json]
cortex-task show --task-id <id> [--json]
cortex-task deps --task-id <id> [--json]
cortex-task lint [--project <p>] [--json]
```

### Write (mutates TASKS.yaml)

```bash
# State
cortex-task claim --project <p> (--task-id <id> | --task <text>) [--agent <name>]
cortex-task unclaim --project <p> --task-id <id>
cortex-task pause --project <p> --task-id <id>
cortex-task resume --project <p> --task-id <id>
cortex-task complete --project <p> --task-id <id> [--note <text>] [--skip-verify --skip-verify-reason <text>]
cortex-task uncomplete --project <p> --task-id <id>

# Approval
cortex-task request-approval --project <p> --task-id <id>
cortex-task approve --project <p> --task-id <id>
cortex-task clear-approval --project <p> --task-id <id>

# Blocking
cortex-task block --project <p> --task-id <id> --reason <text>
cortex-task unblock --project <p> --task-id <id>

# Acceptance verdict (DR-0017 — the manager MUST record a verdict after verifying each child;
# accepted children are never re-delivered, rejected ones count rework rounds)
cortex-task verdict --project <p> --task-id <parent-id> --child <child-id> --verdict accepted|rejected [--note <text>]

# Mutation
# Use the Write tool to stage a JSON object; never put task specification prose in shell arguments.
cortex-task add --project <p> --task-file <path|->
cortex-task spawn --task-file <path|->   # child of current task (CORTEX_TASK_ID); pair with thread_wait
cortex-task edit --project <p> --task-id <id> [--text <t>] [--why <w>] [--done-when <c>] [--plan <path>] [--priority <p>] \
  [--depends-on <id> [...]] [--add-depends-on <id>] [--remove-depends-on <id>] [--clear-depends-on]
cortex-task batch-edit --project <p> --task-ids <id1,id2,...> [<edit flags>]
cortex-task decompose --project <p> --task-id <id> --subtasks-file <path|->

# Maintenance
cortex-task assign-ids [--project <p>]
cortex-task validate
cortex-task stop --task-id <dispatch-id-or-hash> [--dry-run]
```

### Flag semantics (set vs incremental)

`--depends-on` is a **set / replace** flag:
- On `add`: define the initial value.
- On `edit`: replace the entire current list (use `--clear-depends-on` to clear).

For incremental edits (only on `edit` / `batch-edit`):
- Dependencies: `--add-depends-on <id>`, `--remove-depends-on <id>` (each repeatable).

`--depends-on` accepts **both** space-separated and repeatable forms:
```bash
--depends-on a111 a112              # space-separated
--depends-on a111 --depends-on a112 # repeatable
```

### Other notes

- `--dry-run` previews `stop` and `decompose` without mutating.
- `add` / `spawn --task-file -` and `decompose --subtasks-file -` read JSON from stdin.
- Autonomous agents MUST stage add/spawn task JSON with the Write tool at a per-thread/session unique path, replace `<current-thread-or-session-id>` with the real ID, and pass only that path to Bash; shared filenames, shell heredocs, and inline task fields are forbidden.
- All mutation commands return JSON (`task_id`, `agent`, `claimed_at`, …) on success.
- `stop` accepts either the dispatch ID (`dispatch_xxx`) or the TASKS.yaml hash; project is auto-resolved from `pending-tasks.json`.

## Lock Rules

TASKS.yaml uses a file-level lock mechanism to prevent incorrect dispatch by the dispatcher during editing. Lock records are stored in the `lock:` field at the top level of `TASKS.yaml`.

### Commands requiring a lock

The following mutation commands **must** hold the project lock first, otherwise they will exit with an error:

- `add` — Add a new task
- `edit` — Edit task fields
- `batch-edit` — Batch edit
- `decompose` — Decompose into subtasks
- `assign-ids` — Assign task IDs

Lifecycle commands (claim / complete / block / unblock / pause / resume / approval series / stop, etc.) **do not need** a lock — they are called routinely by the dispatcher and cortex-run on automated paths.

### Lock semantics

| Concept | Description |
|---------|-------------|
| **owner** | Lock holder identifier: prefers `$CORTEX_EXECUTION_ID`, falls back to `manual:<user>:<pid>` |
| **TTL** | Fixed 20 minutes. TTL is a safety net — the onMessageEnd hook reminds the agent to release |
| **force** | Expired locks can be forcefully preempted with `--force`, recording a force warning |
| **release** | `lock-release` only releases when owner matches; `lock-force-release` releases unconditionally |

### Hook interception

**Direct editing of `TASKS.yaml` is prohibited.** The PreToolUse hook intercepts Edit/Write operations on `**/TASKS.yaml`:
- Without lock → rejected with prompt to use `cortex-task` CLI
- With lock → allowed (the lock itself guarantees exclusivity)

### Typical multi-step edit workflow

```bash
# 1. Acquire project lock
cortex-task lock-acquire --project foo --note "splitting EXP-017 task"

# 2. Edit/add tasks
cortex-task edit --project foo --task-id ab12 --done-when "..."
# Replace the marker with the real thread/session ID, then stage this path with the Write tool.
cortex-task add --project foo --task-file /tmp/cortex-task-<current-thread-or-session-id>.json

# 3. Release lock
cortex-task lock-release --project foo
```

---

## Workflow

**Step 1 — Read current state.** Start from `cortex-task list --json` (actionable),
`list --all --project <p> --json` (full), `query`/`show`/`deps`/`stats`/`lint` as needed.
Use `--json` when you need structured data for follow-up actions.

**Step 2 — Act.** Parse `$ARGUMENTS` and map the request to the right subcommand.
Prefer `--task-id` when you have an ID; use `--task <text>` only as fuzzy fallback (not
allowed for `add`). For decomposition, prepare the subtasks JSON first, then call
`decompose`. Subtasks inherit the parent task's `plan`; each subtask can override via
`"plan": "<path>"`.

Examples:
- Claim: `cortex-task claim --project <project> --task-id <id> --agent cortex-<machine>`
- Complete: `cortex-task complete --project <project> --task-id <id> --note "Verified via smoke test"`
- Block: `cortex-task block --project <project> --task-id <id> --reason "waiting for approval"`
- Add: replace `<current-thread-or-session-id>` with the real ID, use the Write tool to create `/tmp/cortex-task-<current-thread-or-session-id>.json` containing `{"text":"Run ablation","why":"Isolate depth-sensor contribution","done-when":"Results in EXP-017.md","plan":"context/projects/<project>/experiments/EXP-017.md","priority":"high","template":"<name>"}`, then run `cortex-task add --project <project> --task-file /tmp/cortex-task-<current-thread-or-session-id>.json`
- Set deps: `cortex-task edit --project <project> --task-id <id> --depends-on a111 a112` (replaces full list)
- Append a dep: `cortex-task edit --project <project> --task-id <id> --add-depends-on a113`
- Assign IDs: `cortex-task assign-ids --project <project>`
- Stop preview: `cortex-task stop --task-id <id> --dry-run`

**Step 3 — Report.** Summarize the result briefly and include the canonical CLI response
when useful. If the CLI reports an error, surface it directly instead of inferring a
different outcome.

---

## Notes

- Prefer the canonical CLI over manual `TASKS.yaml` edits whenever a matching command exists.
- Show / deps require `--task-id`.
- All write commands except `assign-ids` / `validate` / `stop` require `--project`.
- `assign-ids` is the canonical way to backfill missing task IDs.
- **`add` required**: the task file must contain `text`; creation conventions also require `why`, `done-when`, `plan`, and `template`. Missing task-file `text` is rejected.
- **Manual Task ID is prohibited**: New tasks must be created via the `add` command; directly editing TASKS.yaml to write IDs is forbidden.
- **The `default` and `scheduler` templates are forbidden for task creation** and rejected at creation time. Small work that doesn't warrant a review pipeline belongs in the `Agent` tool (Step 0), not in a bare single-agent thread.

---

## Task Creation Conventions

### TASKS.yaml Format

```yaml
tasks:
  - id: c8a2
    text: "Task description starting with a verb"
    why: "Why this task needs to be done"
    done-when: "Verifiable completion condition"
    priority: medium        # high | medium | low
    status: open            # open | done
    template: <thread-template-name>
    plan: path/to/design-doc.md
    # Optional fields (defaults apply when omitted)
    depends-on: [a1b2]
    gpu: <machine-name>
    blocked-by: "Blocking reason"
```

### Field Descriptions

#### Lifecycle Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (4-char hex) | Unique task identifier, auto-generated by `add` |
| `text` | string | Task description starting with a verb |
| `why` | string | Why this task needs to be done |
| `done-when` | string | Verifiable completion condition |
| `priority` | enum | high / medium / low |
| `status` | enum | open / done |
| `claimed-by` | string? | Claiming agent name |
| `claimed-at` | string? | Claim date |
| `paused` | bool | Task paused, not participating in dispatch |
| `blocked-by` | string? | External blocking reason |
| `approval-needed` | bool | Requires user confirmation |
| `approved-at` | string? | Approval date |
| `gpu` | string? | GPU machine name |
| `gpu-count` | number | Number of GPUs, default 1 |
| `depends-on` | string[] | List of prerequisite task IDs |
| `parent` | string? | Parent task ID (set by `spawn` / `decompose --keep-parent`) |
| `plan` | string | Design document path (required) |
| `not-before` | string? | Earliest executable date |
| `completed-at` | string? | Completion date |
| `completed-note` | string? | Completion note |

**Note**: `blocked-by` is for actions outside agent control (user approval, external team, prerequisite task completion). `depends-on` is for machine-resolvable dependencies between tasks; when a prerequisite task is `complete`, all references to that ID across projects are automatically cleared.

#### Template Field (Required)

`template` — Specifies the thread template used for dispatch. **Every task must have this field**, no default value. Run `cortex-task add --help` or `!thread templates` to see the current list of available templates. `default` and `scheduler` are rejected at creation time (see Step 0 for the right form for small work).

### Plan Reference Requirements

**Every task must reference an existing markdown document via `--plan <path>`** as the design/plan source for the task. The `plan` field is written to TASKS.yaml by the `add` command, and can be updated with `edit --plan`.

**Document types that can serve as plan** (choose one):
- Thread artifact — The `## Plan (iteration N)` or `## Materialization Summary` artifact produced by the two-stage review template (e.g., director/plan artifact)
- Project decision — `context/projects/<project>/decisions/DR-NNNN.md`
- Project roadmap / mission — `roadmap.md` / `mission.md` (for mission gap analysis / standing tasks)
- Experiment protocol — `context/projects/<project>/experiments/EXP-NNN.md` (when a task directly corresponds to an experiment)
- System-level decision — `context/decisions/DR-NNNN.md`

**Rules**:
- `--plan` path is **relative to repo root** (e.g., `context/projects/orchard/decisions/DR-0012.md`)
- **Tasks without a corresponding plan document must not be created**. If it is just a vague idea, first write a decision / short plan md, then create the task with that as `--plan`.
- Tasks generated by mission gap analysis use `mission.md` or `roadmap.md` as plan; standing tasks use this skill file or the project-level standing-tasks document as plan

**CLI loose constraint vs skill hard requirement**: The CLI `add` does not error when `--plan` is missing, but `task lint` will report a `missing-plan` warning, and **this skill's Task Creation path must provide it**.

### GPU Slot Scheduling

The `gpu` field specifies that a task needs to use GPU on a particular machine. The dispatcher schedules at **per-GPU slot** granularity:

- **Syntax**: `gpu: <machine>` (with `gpu-count` specifying the number of GPUs, default 1)
- The dispatcher detects free GPU slots via `nvidia-smi`, only dispatches when sufficient slots are free
- Automatically sets `CUDA_VISIBLE_DEVICES` during dispatch
- Corresponding GPU slot is released after task completion

### Recursive Execution & Manager Nodes (DR-0014 / DR-0017)

The task tree is recursive: **task = persistent work node, thread = one ephemeral execution
attempt**. Before creating, classify the node (Step 0 gives the full ladder):

- **Leaf task**: a single independently verifiable unit → pick a suitable worker review
  template and create normally. A leaf that needs its own verification stays a leaf —
  verify via the `Agent` tool, or spawn ONE child + `thread_wait` (works from worker
  templates too).
- **Composite task**: 2+ independent units needing coordination / acceptance / rework
  loops, or a decomposition that itself needs judgment → `--template manager`. The manager
  thread decomposes (`decompose --keep-parent`, parent becomes the join/acceptance node),
  suspends (`thread_wait`), verifies each child result, records verdicts, and completes
  itself when everything passes.

**Just-in-time decomposition**: when creating a composite task, do NOT pre-split it to
leaves on the manager's behalf. Each layer decomposes only its own next layer; a child that
is itself composite gets the `manager` template and its manager splits it later with better
information. Flattening the whole tree at planning time is an anti-pattern (DR-0014 §1:
planning happens at the moment of least information). Keep depth at 2-3 levels in practice
(DR-0014 §5).

**Worker escalation**: a worker that discovers its task is mis-scoped or too big does NOT
decompose it — it calls the `thread_abort` tool (kind `too-big`, with a diagnosis); the
task gets blocked with the diagnosis and the owning manager (or a human) re-plans
(DR-0015 control plane).

### Task Decomposition

**The variable you optimize is decomposability, not fineness.** A good cut is the one that
falls at the *narrowest interface* between the pieces (lowest coupling), NOT the one that
produces the *most* pieces. Splitting a task into many tightly-coupled fragments — each of
which still needs the whole system in context to do its part — is worse than not splitting at
all: you pay full delegation overhead and every fragment drifts. Cut where the seam is thin;
leave coupled work whole.

#### Iron Rule 1: Cut at the Seam

A condition being **independently verifiable is necessary but not sufficient** to make it its
own task. The cut is valid only when, in addition:

- **(a) Verifiable without naming the sibling's internals**: the child's `done-when` can be
  written and checked without dictating *how* another child is implemented (no "call the
  `foo()` that task X creates" at line level). If you must specify another child's
  implementation to make this one verifiable, the seam is in the wrong place.
- **(b) Interface-stable**: if a sibling's internal implementation changed but its *interface*
  held, this child would not need to change. If a sibling's internal change forces this child
  to change, they are coupled — keep them in one task.

"One criterion = one task" still holds **as a corollary** when the criteria are genuinely
decoupled (the usual case for independent experiments / parallel artifacts). It does NOT hold
when criteria share mutable state or a single evolving abstraction.

**Anti-pattern: Checklist-in-Task** — Do not use numbered sub-conditions (1)(2)(3)... to pack
multiple *independent* work items into one "Done when".

**Exception 1 — Atomic verification**: Multiple sub-conditions are different verification
dimensions of the same atomic operation (e.g., "script runs without errors + output file
exists + metrics within reasonable range").

**Exception 2 — Article writing**: Long-form writing such as papers is not split by section;
execute as a single task to ensure cross-section coherence.

#### Decomposition self-audit (run per child BEFORE committing the split)

For each proposed child, answer all four. **Any "no" → re-cut, merge, or refuse to split.**
Do not treat the split as final until every child passes.

1. **Interface stated in 1–2 lines?** Can you say what this child consumes and what it
   produces in one or two lines? Can't state it crisply → the interface is fat → bad cut.
2. **`done-when` verifiable without naming implementation?** If you have to name specific
   functions/lines of another child to verify this one → either it is actually a leaf (just do
   it inline, don't spawn) or the cut is wrong.
3. **Survives a sibling refactor?** If a sibling's interface holds but its internals change,
   does this child stay unaffected? If not → coupled → merge them.
4. **Distinct context from the parent?** Does this child read a meaningfully *smaller /
   different* slice of context than the parent? If it needs the same broad context → the cut
   bought nothing.

#### When NOT to decompose

Forcing a split on a non-decomposable problem produces drift, not progress. If no thin seam
exists (the self-audit keeps failing because everything depends on everything — a tangled
reconcile loop, a single evolving abstraction, shared mutable state):

- **Do the coupled core whole**, in one strong-model task. Coupling that cannot be cut is a
  signal to keep the work together, not to fragment it.
- **Or create a "refactor to expose seams" task first**, then decompose the now-modular result.
  "Make it decomposable" is itself a legitimate task.

Refusing to split, with a one-line reason, is a valid and often correct outcome.

**Example A — clean seam (parallel, DO split)**: independent experiments share no mutable
state; each passes the self-audit.

```yaml
# ❌ 3 independent experiments + analysis packed into 1 task
- id: x001
  text: "Run missing baseline experiments"
  done-when: "(1) BC baseline done (2) DG/DANN/CORAL done (3) vision encoder comparison done (4) result analysis done"

# ✅ Split into 3 experiments + 1 analysis task (all referencing the same experiment protocol as plan)
- id: a001
  text: "Run BC baseline experiment"
  plan: context/projects/orchard/experiments/EXP-017.md
  done-when: "Training completed, results saved to results/"

- id: a002
  text: "Run domain adaptation baseline"
  plan: context/projects/orchard/experiments/EXP-017.md
  done-when: "DG/DANN/CORAL training completed, results saved to results/"

- id: a003
  text: "Run vision encoder comparison experiment"
  plan: context/projects/orchard/experiments/EXP-017.md
  done-when: "Comparison experiment completed, results saved to results/"

- id: a004
  text: "Analyze baseline experiment results"
  plan: context/projects/orchard/experiments/EXP-017.md
  depends-on: [a001, a002, a003]
  done-when: "Three sets of experiment results compared and analyzed, conclusions recorded in experiments/EXP-NNN.md"
```

**Example B — coupled code (DON'T fine-split)**: "fix the reconcile loop so state X, Y, Z
converge" reads like three criteria, but X/Y/Z are updated through one shared state machine —
changing the convergence logic for X forces Y and Z to change too (self-audit #3 fails).

```yaml
# ❌ Fine-split by symptom — each child needs the whole state machine in context, and they
#    stomp on each other. Three drifting fragments, full delegation overhead, no real seam.
- id: y001
  text: "Make state X converge"
  done-when: "X reaches steady state"
- id: y002
  text: "Make state Y converge"
  done-when: "Y reaches steady state"
- id: y003
  text: "Make state Z converge"
  done-when: "Z reaches steady state"

# ✅ Keep the coupled core whole (one strong-model task)...
- id: y010
  text: "Rework reconcile loop so X/Y/Z converge to a stable state"
  plan: context/projects/foo/decisions/DR-00NN.md
  done-when: "Reconcile converges X, Y, Z together under the loop's tests; no oscillation"

# ✅ ...OR, if the loop is too tangled to reason about, expose seams FIRST, then decompose
- id: y020
  text: "Refactor reconcile loop to isolate X/Y/Z update paths behind a clear interface"
  plan: context/projects/foo/decisions/DR-00NN.md
  done-when: "Each state's update path is a separately-testable function with a stated contract"
# (a follow-up task, depends-on: [y020], may then split convergence work along the new seams)
```

#### Iron Rule 2: Explicit Dependency Declaration

If decomposed tasks have execution order requirements, they **must use `depends-on` or `blocked-by` to explicitly declare** them. Do not rely on implicit list order.

```yaml
# ✅ Explicitly orchestrated with depends-on
- id: d001
  text: "Prepare training data"
  plan: context/projects/orchard/decisions/DR-0008.md
  done-when: "WebDataset shards generated"

- id: d002
  text: "Train model"
  plan: context/projects/orchard/experiments/EXP-018.md
  depends-on: [d001]
  done-when: "Training completed, checkpoint saved"

- id: d003
  text: "Evaluate model"
  plan: context/projects/orchard/experiments/EXP-018.md
  depends-on: [d002]
  done-when: "Eval metrics recorded in experiments/EXP-NNN.md"
```

#### Decomposition candidate signals (NOT auto-split triggers)

These are hints that a task *might* be decomposable — they tell you to **run the self-audit**,
not to split on sight. A task touching many files or steps may still be one coupled unit; file
count is never sufficient justification to cut. Split only if the self-audit passes.

- Done-when contains multiple **decoupled** completable conditions (Iron Rule 1)
- Subtasks have sequential dependencies that are not yet declared (Iron Rule 2)
- 2+ steps that pass the interface-stable test (each survives the others' refactor)
- 3+ files **with a thin seam between them** (not 3+ files that all share one abstraction)
- Mixes blocked and unblocked work
- Mixes mechanical work and judgment-based work *and* the two have a clean handoff

When a split does happen and a child is itself composite (it would trigger these signals
again), give that child the `manager` template as a single node — do not keep splitting
downward; that is its manager's job (just-in-time decomposition).

### Stage Boundary Constraints

**For projects using the stage-gate mechanism**: Each task creation operation only creates tasks **up to the next gate**; do not pre-create tasks across gates for future stages.

- When creating next-stage tasks, must end with a gate task: `GATE: Stage <N> <stage name>`, whose `--depends-on` references all task IDs in that stage
- Gate tasks form an execution barrier — no tasks for the next stage may be dispatched before passing through the gate for re-evaluation
- Pre-creating tasks across multiple stages **violates this constraint**: future stage tasks should be authorized by the next gate's verdict, not pre-judged by the current creator

**Exceptions**:
- **Iterate branch** patch tasks use the new iter gate as cutoff point (`GATE: Stage <N> (iter <k>) <stage name>`)
- **Mission gap analysis** / **standing tasks** are allowed to create maintenance tasks not belonging to a specific stage (e.g., STATUS.md update, cross-reference verification)
- Projects not using stage-gate are not subject to this constraint

### Mission Gap Analysis (Empty Queue Fallback)

When there are no executable tasks, do not invent work. Execute mission gap analysis:
1. Read the project mission.md success conditions
2. Read the project roadmap.md milestone verification conditions
3. Compare against existing TASKS.md task coverage
4. Auto-generate tasks for uncovered conditions
5. If no gap → nothing to do, record and end

### Task Supply Health

Task supply health indicators:
- Each active project has at least 2 actionable tasks
- Total actionable tasks >= 5
- No more than 50% of tasks are blocked

Auto-generation strategy when supply is low:
1. Mission gap analysis (from mission → task)
2. Roadmap-driven decomposition (split from roadmap milestones)
3. Experiment follow-up (generate follow-up tasks from experiment conclusions)
4. Standing tasks (periodic maintenance tasks)

### Standing Tasks (Recyclable)

The following template tasks can be auto-created when supply is low:

```yaml
- text: "Update STATUS.md for {project}"
  why: "Keep project status current"
  done-when: "STATUS.md reflects actual machine state and latest experiment results"
  priority: low
  plan: context/projects/{project}/mission.md

- text: "Verify cross-references in {project}"
  why: "Prevent documentation drift"
  done-when: "All file references in project files point to existing paths"
  priority: low
  plan: context/projects/{project}/mission.md
```
