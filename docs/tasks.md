# Cortex Task System

The task system is Cortex's structured work queue. Tasks live in `TASKS.yaml` files — one per project — and are managed through the `cortex-task` CLI. The system supports dispatching tasks to fleet workers, tracking execution on remote machines, and archiving completed work.

## TASKS.yaml Format

Each project's `TASKS.yaml` contains a flat list of tasks. Each task has the following fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string (4 hex chars) | Yes | Unique task identifier within the project (e.g., `f7cf`, `6a07`) |
| `text` | string | Yes | Verb-first task description |
| `why` | string | Yes | Rationale — why this task matters |
| `done-when` | string | Yes | Verifiable completion criteria |
| `priority` | `high` \| `medium` \| `low` | Yes | Task priority |
| `status` | `open` \| `done` \| `pending` | Yes | Core status (only these 3 are stored; derived statuses are computed) |
| `template` | string | Yes | Thread template name used when dispatching (e.g., `coder-review`) |
| `plan` | string | No | Path to a design document |
| `depends-on` | string[] | No | List of task IDs this task depends on |
| `gpu` | string \| null | No | Target machine name (e.g., `lab2`) |
| `gpu-count` | number | No | Number of GPUs required (default: 1) |
| `blocked-by` | string \| null | No | External blocking reason (free text) |
| `claimed-by` | string \| null | No | Agent identifier that claimed the task |
| `claimed-at` | string \| null | No | ISO timestamp of claim |
| `paused` | boolean | No | Whether the task is paused |
| `approval-needed` | boolean | No | Whether approval is required before dispatch |
| `approved-at` | string \| null | No | ISO timestamp of approval |
| `not-before` | string \| null | No | Date gate: don't dispatch before this ISO date |
| `completed-at` | string \| null | No | ISO timestamp of completion |
| `completed-note` | string \| null | No | Note added at completion |
| `pending-at` | string \| null | No | ISO timestamp when marked pending (cortex-run) |

YAML keys use kebab-case (`done-when`, `depends-on`, `claimed-by`, etc.) which are mapped to snake_case fields internally.

### Example Tasks

```yaml
- id: f7cf
  text: "Replace backend dispatch with unified adapter.runWithAdapter"
  why: "Duplicated backend dispatch paths are a maintenance burden"
  done-when: "mode-manager.ts uses runWithAdapter for both backends; fixture replay tests green"
  priority: high
  status: open
  template: coder-review
  plan: decisions/0002-unified-backend-dispatch.md

- id: 5349
  text: "Full pipeline integration test"
  why: "Individual stages pass but end-to-end hasn't been validated"
  done-when: "Full pipeline run (prompt → VLA → dataset) completes with >=80% generation stage success rate"
  priority: high
  status: open
  template: experiment-runner
  gpu: lab2
  gpu-count: 1
```

### Project Lock

`TASKS.yaml` can optionally contain a `lock` section that prevents concurrent mutation:

```yaml
lock:
  owner: "exec_local_abc"
  acquired_at: "2026-04-23T12:00:00.000Z"
  expires_at: "2026-04-23T12:20:00.000Z"
  note: "restructuring tasks"
```

The lock has a fixed 20-minute TTL. Commands that mutate the task list (`add`, `edit`, `batch-edit`, `decompose`) require the caller to hold the lock. The lock is automatically released when the owning execution completes.

## Task Lifecycle

### Core States (Stored)

Tasks have three core states stored in YAML:

- **`open`** — available to be claimed
- **`done`** — completed (terminal)
- **`pending`** — dispatched to a remote machine, waiting for cortex-run completion

### Derived States (Computed)

Additional states are computed from boolean flags:

| Condition | Derived State |
|-----------|---------------|
| `claimed_by` is set | `in-progress` |
| `blocked_by` is set | `blocked` |
| `paused` is true | `paused` |
| `approval_needed` is true and `approved_at` is null | `approval-needed` |
| `approved_at` is set | `approved` (can be dispatched) |

### State Transitions

```
open ──claim──→ in-progress ──complete──→ done
 │                  │
 ├──block──→ blocked ├──unclaim──→ open
 │    │               │
 │    └──unblock──→ open
 │
 ├──pause──→ paused ──resume──→ open (clears claim)
 │
 ├──request-approval──→ approval-needed ──approve──→ open (approved_at set)
 │
 └──pending──→ pending ──(cortex-run result)──→ done / open+blocked
                  │
                  └──reopen──→ open
```

**Guard rules:**

- Cannot claim an already-claimed task (409 error)
- Cannot claim a blocked or done task
- Cannot complete a blocked or paused task
- Setting `blocked_by` auto-clears `claimed_by`, `claimed_at`, and `pending_at`, and normalizes a `pending` status back to `open` (so an unblocked task is dispatchable again — `blocked_by` is what gates dispatch while blocked, not the status)
- Pausing a task clears `claimed_by` and `claimed_at`
- `pending` clears `claimed_by` and `blocked_by`, sets `pending_at`
- `unblock` clears `blocked_by` and restores a legacy `pending` status to `open`
- `reopen` restores a stuck `pending` task to `open` (rescue path for a lost cortex-run callback); refuses a `done` task

## Done-When Discipline

The `done-when` field is the most important field on a task. It must describe **verifiable completion criteria**, not vague intentions.

**Good examples:**

- `"mode-manager.ts:310-311 replaced with runWithAdapter; both backends route through same function; fixture replay tests green"`
- `"Full pipeline run completes with >=80% generation stage success rate"`
- `"docs/architecture.md exists with all six layers documented and verified against actual code"`

**Bad examples (too vague):**

- `"Fix the bug"`
- `"Improve performance"`
- `"Write documentation"`

### Completion Verification

When a task is marked complete via `cortex-task complete`, the system runs automatic verification (`verifyCompletionEvidence`):

1. **Git log check**: Runs `git log --oneline --grep=<taskId>` to find commits that reference the task ID. At least one commit that is NOT a claim/unclaim commit must exist.
2. **Artifact check**: If git check fails, checks if any file path mentioned in the `done-when` text exists in the data directory.

If neither check passes, the command returns an error: `"no evidence of work: no matching git commit and no Done-when artifact found in repo"`. Users can bypass with `--skip-verify` (optionally with `--skip-verify-reason`).

## Blocked-By Semantics

The `blocked_by` field is for **external blockers only** — things that cannot be resolved by writing code or configuring tools. Examples of valid blockers: waiting for GPU allocation, waiting for a dataset to be delivered, waiting for API access approval.

Setting a task as blocked automatically unclaims it. You cannot complete a blocked task — it must be unblocked first.

### Auto-Block Quarantine

The task dispatch system has an automatic quarantine mechanism: if a dispatched task fails 3 consecutive times, the task is automatically blocked with the last error message in `blocked_by`. This prevents the dispatcher from repeatedly attempting a broken task.

## Stale Claim Detection

At startup, the server reconciles dispatcher claims against their owners. A task claimed by `task-dispatcher` whose execution did not survive the restart is automatically unclaimed and returns to the dispatch queue. Claims with a surviving owner are left in place: a suspended manager thread waiting on children, a rate-limit-paused thread awaiting auto-resume, and a remote `cortex-run` tracked by the pending task tracker all legitimately hold their claim across restarts. Manual claims (any `claimed_by` other than `task-dispatcher`) are never touched.

The 3-day rule: if a task has been `claimed_by` an agent for more than 3 days without completion, it is considered a stale/orphan claim and should be investigated. This manual convention covers the claims the automatic reconciliation deliberately respects, such as manual claims.

Separately, the pending task tracker has a 4-hour timeout for dispatched tasks on remote machines — if a dispatched task hasn't reported back within 4 hours, its tracking state is cleared.

## Task Dispatch

The dispatch pipeline is how tasks get executed automatically.

### Trigger

The built-in task dispatcher checks periodically (every 30 seconds by default). `taskDispatchEnabled` and `taskDispatchIntervalMs` in `config/settings.json` control the loop.

### Dispatch Flow

1. **Dry-run select**: Find a task that can be dispatched (without claiming it yet)
2. **Rate-limit check**: Ensure the system isn't rate-limited
3. **Select and claim**: `selectAndClaimTask()` picks the highest-priority actionable task
4. **GPU check**: If the task requires GPU, verify the target machine is online and has free GPUs
5. **Deduplication**: Skip if a similar task is already running (checked via execution registry)
6. **Thread creation**: Create a thread from the task's template, run it with project context (see [threads.md](./threads.md) for the thread execution model)
7. **Task completion**: On thread success, auto-complete the task. On failure, increment the failure counter (3 consecutive failures → auto-block)

### Selection Priority

Tasks are selected in this order:

1. Tasks from higher-priority projects first
2. Tasks with a populated `done-when` field over those without
3. Tasks with higher `priority` value (`high` > `medium` > `low`)

### Pending Tasks

When a task is dispatched to a remote machine for long-running execution (via `cortex-run`), it is marked as `pending`. The remote machine's `cortex-run-watcher` tracks the process and reports back with success/failure via WebSocket `task-callback` messages. The server then completes or blocks the task accordingly.

## Cortex-Run Watchdog (DR-0011)

The `cortex-run` system handles long-running task execution on remote machines.
See [cli-reference.md](./cli-reference.md) for the full `cortex-run` CLI
reference, and [scheduling.md](./scheduling.md) for how the built-in task
dispatcher is configured.

- **Server side**: `cortex-run` CLI forwards to the remote client via `sendCommand`
- **Client side**: `cortex-run-watcher.ts` spawns the user command as a detached child process, monitors it with two-layer stall detection (output byte stall and progress line stall), auto-picks GPU via `nvidia-smi`, writes state/output/result files, and sends a `task-callback` WebSocket message on completion
- **Client side**: `cortex-run-launch.ts` handles launch/cancel/flush cycles, with orphan detection for dead processes

The three-layer process model:

```
cortex-client (WebSocket connection to server)
  └── cortex-run-watcher (detached, unref'd)
        └── user command (e.g., python train.py)
```

## Task Archive

Completed tasks are automatically archived after 3 days (`ARCHIVE_AGE_DAYS = 3`). The built-in archiver runs every 6 hours by default and is controlled by `taskArchiveEnabled` and `taskArchiveIntervalMs` in `config/settings.json`.

**Archive process:**

1. Scan all projects in `context/projects/`
2. Find tasks with `status: done` and `completed-at` older than 3 days
3. Remove them from `TASKS.yaml`
4. Append them to `tasks-archive.md` in markdown checklist format with text, id, why, done-when, priority, completion date, and note
5. Auto-commit with message: `auto-archive: completed tasks (<project>: <N> tasks)`

Tasks without a `completed-at` date are never archived.

## Cortex-Task CLI

The `cortex-task` CLI provides full task lifecycle management. For the complete
CLI reference including every subcommand and flag, see
[cli-reference.md](./cli-reference.md). All commands operate on the project in the current working directory or accept a `--project` flag.

### Read Commands

| Command | Description |
|---------|-------------|
| `list` | Show actionable tasks (default). Use `--all` for all tasks including done/blocked/paused |
| `query` | Filter tasks by status, priority, text pattern, or task ID |
| `show --task-id <id>` | Show detailed information for one task |
| `deps --task-id <id>` | Show the dependency graph for a task |
| `lint` | Validate task structure (missing IDs, dangling dependencies, cycles) |
| `stats` | Task supply statistics per project (counts by status and priority) |

### State Commands

| Command | Description |
|---------|-------------|
| `claim --task-id <id>` | Mark a task as in-progress (`--agent` defaults to `cortex-local`) |
| `unclaim --task-id <id>` | Remove in-progress status |
| `pause --task-id <id>` | Pause a task (clears claim) |
| `resume --task-id <id>` | Resume a paused task |
| `pending --task-id <id>` | Mark as pending (waiting for cortex-run result) |
| `reopen --task-id <id>` | Restore a stuck `pending` task back to `open` (rescue a lost cortex-run callback) |
| `complete --task-id <id>` | Mark complete (`--note`, `--skip-verify` to bypass verification) |
| `uncomplete --task-id <id>` | Reverse a completed task back to open |
| `verdict --task-id <parent> --child <id> --verdict accepted\|rejected` | Record a manager's acceptance verdict for a delivered child into the parent's acceptance ledger (see [Manager Tasks and the Acceptance Ledger](#manager-tasks-and-the-acceptance-ledger-dr-0017); full syntax in [cli-reference.md](./cli-reference.md)) |

### Approval Commands

| Command | Description |
|---------|-------------|
| `request-approval --task-id <id>` | Set approval-needed flag |
| `approve --task-id <id>` | Approve (sets approved_at, clears approval-needed) |
| `clear-approval --task-id <id>` | Clear approval status |

### Blocking Commands

| Command | Description |
|---------|-------------|
| `block --task-id <id> --reason "..."` | Block a task with a reason |
| `unblock --task-id <id>` | Unblock a task |

### Mutation Commands

| Command | Description |
|---------|-------------|
| `add` | Add a new task (`--text`, `--why`, `--done-when`, `--template`, `--priority`, etc.) |
| `edit --task-id <id>` | Edit task fields |
| `batch-edit --task-ids <id1,id2>` | Apply same edit to multiple tasks |
| `decompose --task-id <id> --subtasks-file <path>` | Replace a task with subtasks |

### Lock Commands

| Command | Description |
|---------|-------------|
| `lock-acquire` | Acquire project lock (20-minute TTL) |
| `lock-release` | Release project lock |
| `lock-status` | Show lock status for all or one project |
| `lock-force-release` | Force-release a project lock |

### Maintenance Commands

| Command | Description |
|---------|-------------|
| `assign-ids` | Auto-assign 4-hex IDs to tasks missing one |
| `validate` | Validate all task IDs across projects (check for dupes, missing refs) |
| `stop --task-id <id>` | Kill a dispatched task process |

Mutation commands (`add`, `edit`, `batch-edit`, `decompose`) require the caller to hold the project lock.

## One Criterion, One Task (DR-0006)

Each task should have exactly one verifiable completion criterion. A task with multiple independent criteria should be decomposed into subtasks using the `decompose` command. This ensures clean dispatch, clear ownership, and unambiguous completion verification.

## Manager Tasks and the Acceptance Ledger (DR-0017)

Simple work is a single leaf task dispatched to a worker thread. **Composite work** — a goal that decomposes into several independently verifiable units and needs coordination, acceptance, and rework — is modeled instead as a **manager task**.

### Manager Task Node

A task whose `template` is `manager` is a **composite task node**, owned by a resident **manager thread**. The manager does not do the work itself. Its lifecycle is:

1. **Decompose** — split the task into child tasks (typically via `decompose --keep-parent`, so the parent survives as the join/acceptance node that depends on its children).
2. **Suspend** — call `thread_wait` and sleep while the children run.
3. **Verify** — once children finish, verify each child's deliverable against that child's own `done-when` (acceptance before trust: read the files, run the tests — never accept a child's self-report as evidence).
4. **Record a verdict** — accept or reject each delivered child (see the acceptance ledger below).
5. **Integrate and complete** — after every child is accepted, integrate the results and complete the parent task.

The full manager thread lifecycle — its durable task-keyed artifact, the `thread_wait` checkpoint gate, and session rotation/rehydration — is documented in [threads.md](./threads.md).

### Acceptance Ledger

The acceptance ledger is a durable, machine-readable record of which child results the manager has received and judged. It lives at:

```
context/projects/{project}/manager/{taskId}/ledger.json
```

alongside the manager's task-keyed artifact, and is written sync-atomically as JSON.

**Why it exists:** cross-incarnation dedupe of child-result delivery for *task* children. The per-thread delivery record only dedupes within a single manager incarnation; the ledger dedupes **across incarnations** (session rotation, server restart, or manager replacement), so a delivered result is neither lost nor delivered twice when the manager's LLM session is replaced.

**Structure:** `{ parent, project, children: { <childId>: LedgerEntry } }`, where each `LedgerEntry` has these fields:

| Field | Meaning |
|-------|---------|
| `child` | Child task id |
| `kind` | How the child terminated: `completed` or `blocked` |
| `delivered_at` | ISO timestamp the result was delivered to the manager |
| `verdict` | `pending` \| `accepted` \| `rejected` |
| `verdict_at` | ISO timestamp of the verdict (null until recorded) |
| `verdict_note` | Manager's note on the verdict |
| `rework_round` | How many times the child has been rejected and sent back |

**Delivery semantics** (delivery is at-least-once per incarnation until a verdict is recorded):

- **`accepted`** → the child result **never re-delivers** to future manager incarnations.
- **`pending`** (delivered but not yet judged — including the case where the incarnation died before judging) → **re-delivers** to a fresh incarnation. The bias is deliberate: re-deliver rather than lose.
- **`rejected`** → re-opens to `pending` and re-delivers when the child completes again after rework, **preserving `rework_round`**.

**Fail-open:** a missing or corrupt ledger degrades to an empty ledger — the worst case is a result re-delivered, never a result lost.

### The `verdict` Command in the Acceptance Loop

The manager writes verdicts into the ledger through the `cortex-task verdict` command — the ledger's write path. In the manager's verify phase, for each delivered child:

- **On pass** → `verdict --verdict accepted`. The child result never re-delivers again.
- **On fail** → `verdict --verdict rejected --note "<gap>"`. This increments the child's `rework_round`; the child is then reworked (e.g. `uncomplete` + edit, or a revision child) and re-delivered, at which point it re-opens for another verdict.

`--verdict` must be exactly `accepted` or `rejected`, and `--child` is required. For the exact command signature and flags, see [cli-reference.md](./cli-reference.md).

## Task Dispatch Concurrency

The task dispatcher checks capacity before every dispatch attempt. `taskDispatchMaxConcurrent` sets an explicit limit; its default `null` uses `max(4, os.cpus().length - 2)`. A reservation covers the interval between task selection and execution registration, so rapid timer ticks cannot exceed the limit.
