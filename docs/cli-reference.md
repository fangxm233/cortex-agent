# CLI Reference

Cortex ships three binaries, registered in `agent-server/package.json`:

| Binary | Entry point | Purpose |
|---|---|---|
| `cortex` | `dist/entry/cli.js` | Server management and initialization |
| `cortex-task` | `dist/domain/tasks/system/task-cli.js` | Task system read and mutation |
| `cortex-run` | `dist/domain/tasks/system/cortex-run.js` | Remote command dispatch |

All three accept `--help` (or `-h`) to print their usage. The `cortex task`
subcommand delegates directly to `cortex-task`.

---

## cortex

```
cortex <command> [options]
```

Server lifecycle and initialization CLI.

### Commands

**`cortex init [--home <path>] [--gateway-config-dir <path>] [--force]`**

Interactive initialization wizard. Creates the `CORTEX_HOME` directory
structure, prompts for backends (Claude Code / PI), interaction platform
(Slack), gateway usage, and system service registration.
Generates `.env` with platform tokens, copies default configs, and
auto-generates `mcp-config.json` and `mode.json`.

Options:
- `--home <path>` — set `CORTEX_HOME` (default: `$CORTEX_HOME` or `~/.cortex/`)
- `--gateway-config-dir <path>` — gateway config output directory (default: `~/.aistatus/`)
- `--force` — overwrite existing configs (`.env`, `budget.json`, `mode.json`, etc.)

**`cortex start`**

Fork `dist/entry/app.js` as a child process, inherit stdio. This is the
primary way to run Cortex in the foreground. The child process runs the
Slack bot, webhook server, and all agent orchestration.

**`cortex daemon`**

Fork `dist/entry/daemon.js` as a child process, inherit stdio. The daemon
wraps `app.js` with file watching and auto-restart on crash. Touching
`$STORE_DIR/.restart` signals the daemon to drain and respawn `app.js`.

**`cortex restart`**

Signal a running daemon to drain and respawn `app.js` by touching the
`.restart` trigger file at `$STORE_DIR/.restart`. If no daemon is running,
this is a no-op beyond creating the file.

**`cortex task <subcommand> [options]`**

Delegate to `cortex-task`. See the `cortex-task` section below for all
subcommands.

**`cortex config`**

Print resolved paths and initialization status. Shows `INSTALL_ROOT`,
all data directories, and whether `.env`, `mcp-config.json`, and
`mode.json` exist.

**`cortex doctor [--fix] [--json]`**

Health-check the whole installation in one pass and report what is wrong.
The default run is read-only and safe at any time. It inspects four areas:

- Runtime & process — Node version, `git` on PATH, the configured backend
  binary (`claude` / `pi`), and whether the daemon is running.
- Backend install / login — data directories exist and are writable, `.env`
  is present, the WebSocket/webhook auth tokens are set, `ANTHROPIC_API_KEY`
  status, and that `mode.json`, `profiles.json`, and `mcp-config.json` are
  present and valid. It also smoke-tests the installed PI runtime and its
  `login` export, then summarizes expired or logged-out in-use providers from
  the credential-free backend auth snapshot. These two checks warn rather than
  fail. In API mode, a healthy gateway with no local key is reported as
  gateway-backed information instead of a false logged-out warning.
- Messaging platform — resolves `CORTEX_PLATFORM` and validates the
  credentials for each enabled platform (Slack `xoxb-`/signing/`xapp-`,
  Feishu app id/secret).
- Gateway — `~/.aistatus/gateway.yaml` presence and a health probe of
  `http://127.0.0.1:9880/status`. The probe is reported as a failure only
  when the gateway is actually in use; otherwise it is skipped.

Each check prints `[OK]`, `[WARN]`, `[FAIL]`, or `[--]` (skipped) with a
short detail and, for problems, a fix hint. The command exits `1` when any
check fails, else `0`.

Options:
- `--fix` — apply safe, idempotent repairs only: create missing data
  directories, generate missing auth tokens, and rebuild `mcp-config.json`.
  It never deletes configuration or overwrites existing credentials. After
  fixing, diagnostics re-run so the summary reflects the repaired state.
- `--json` — emit the full report (sections, checks, counts) as JSON for
  scripting.

**`cortex auth status [--json]`**

Read the normalized Claude Code and PI authentication snapshot. The default
text output shows a concise status overview, while `--json` returns the full
`AuthStatusSnapshot` for scripting. Both forms omit credential values and
fragments.

This subcommand is read-only. Remote login starts from `!login` in Slack or
Feishu, or **Settings → Platform → Backend login** in the Web UI; there is no
OAuth or API-key login flag on `cortex auth`.

Options:
- `--json` — print the complete credential-free status snapshot as JSON
- `--help`, `-h` — show auth command help

See [Backends: Remote login](./backends.md#remote-login) for login commands,
provider capability rules, and expiration handling.

**`cortex setup-gateway [--dry-run] [--output-dir <path>]`**

Auto-detect Claude Code and PI configurations from their local config
files, generate `~/.aistatus/gateway.yaml` (with backup of existing),
and write `$CORTEX_HOME/config/profiles.json`. Run this whenever you add
a new API key or change models.

Options:
- `--dry-run` — print the generated gateway.yaml to stdout without writing
- `--output-dir <path>` — write gateway.yaml and profiles.json under `<path>` instead of defaults

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (invalid command, missing config, runtime failure) |

---

## cortex-task

```
cortex-task <command> [options]
```

Read and mutate TASKS.yaml files across projects. For the full task system
lifecycle, format reference, and dispatch model, see [tasks.md](./tasks.md). Available both as a
standalone binary and via `cortex task <command>`.

### Read commands

These commands do not modify any files. They all support `--json` for
machine-readable output.

**`list [--project <name>] [--status <status>] [--priority <level>] [--text <filter>] [--has-deps] [--no-deps] [--json]`**

Show actionable tasks (default). Filters by project, status, priority, text
substring, or dependency presence. Use `--all` to include completed tasks.

**`all [options]`**

Alias for `list --all`. Shows all tasks including completed ones.

**`query [--project <name>] [--status <status>] [--priority <level>] [--has-deps] [--no-deps] [--json]`**

Filter across all tasks (including completed). Same filter options as `list`
but always scans the full task set.

**`show --task-id <id> [--json]`**

Show detailed information for a single task: text, why, done-when, plan,
status, dependencies, and dependent tasks.

**`deps --task-id <id> [--json]`**

Show the dependency graph for one task: what it depends on and what depends
on it.

**`lint [--project <name>] [--json]`**

Validate task structure: missing IDs, dangling dependencies, cycles, and
invalid template names.

**`stats [--json]`**

Print task supply statistics per project: counts by status and priority.

### State commands

These commands require `--project` and either `--task-id` or `--task`.

**`claim --project <name> (--task-id <id> | --task <text>) [--agent <name>]`**

Mark a task as in-progress (claimed). The `--agent` flag records which agent
claimed it (default: `cortex-local`).

**`unclaim --project <name> (--task-id <id> | --task <text>)`**

Remove the claimed status from a task, returning it to open.

**`pause --project <name> (--task-id <id> | --task <text>)`**

Pause a task (typically an in-progress one). Paused tasks are not dispatched.

**`resume --project <name> (--task-id <id> | --task <text>)`**

Resume a paused task.

**`pending --project <name> (--task-id <id> | --task <text>)`**

Mark a task as pending (waiting for a `cortex-run` process to complete).

**`reopen --project <name> (--task-id <id> | --task <text>)`**

Restore a stuck `pending` task back to `open` so the dispatcher can pick it up
again. Use this to rescue a task that stayed `pending` after a lost `cortex-run`
callback. It is idempotent on an already-open task and refuses a completed task
(use `uncomplete` for those).

**`complete --project <name> (--task-id <id> | --task <text>) [--note <text>] [--skip-verify] [--skip-verify-reason <text>]`**

Mark a task as complete. Requires a `--note` describing what was done. By
default, Cortex validates that the `done-when` criteria were met. Use
`--skip-verify` with `--skip-verify-reason` to bypass validation.

**`uncomplete --project <name> (--task-id <id> | --task <text>)`**

Reverse a completed task, returning it to its previous state.

### Approval commands

**`request-approval --project <name> (--task-id <id> | --task <text>)`**

Mark a task as needing approval.

**`approve --project <name> (--task-id <id> | --task <text>)`**

Approve a task that was waiting for approval.

**`clear-approval --project <name> (--task-id <id> | --task <text>)`**

Clear the approval status from a task.

### Blocking commands

**`block --project <name> (--task-id <id> | --task <text>) --reason <text>`**

Block a task with a reason. Blocked tasks are not dispatched.

**`unblock --project <name> (--task-id <id> | --task <text>)`**

Unblock a previously blocked task.

### Acceptance commands

**`verdict --project <name> --task-id <parent id> --child <child id> --verdict accepted|rejected [--note <text>]`**

Record a manager's acceptance verdict for a delivered child task into the
parent task node's acceptance ledger (DR-0017). Required: `--project`,
`--task-id` (the parent/manager task), `--child` (the child task id), and
`--verdict`, which must be exactly `accepted` or `rejected` (any other value is
an error). `--note` optionally records why. An `accepted` child result **never
re-delivers** to future manager incarnations; a `rejected` verdict bumps the
child's `rework_round` and **re-opens** the child for another verdict when it
completes again after rework. This command writes a per-node ledger and does
not require a project lock. For the acceptance-ledger data model, see
[tasks.md](./tasks.md).

### Mutation commands

These commands require a project lock (`cortex-task lock-acquire`) before
they can run, to prevent concurrent edits to the same TASKS.yaml.

**`add --project <name> --text <text> [--why <text>] [--done-when <text>] [--plan <path>] [--priority <level>] [--template <name>] [--depends-on <id...>]`**

Add a new task. Required: `--text`. Optional: `--why` (rationale),
`--done-when` (success criteria), `--plan` (reference to design doc),
`--priority` (high/medium/low, default: medium), `--template` (thread
template name), `--depends-on` (space-separated hex IDs).

**`edit --project <name> (--task-id <id> | --task <text>) [--text <text>] [--why <text>] [--done-when <text>] [--plan <path>] [--priority <level>] [--depends-on <id...>] [--add-depends-on <id>] [--remove-depends-on <id>] [--clear-depends-on]`**

Edit task fields. At least one field must be specified. Dependencies can be
set (replace), appended (`--add-depends-on`, repeatable), removed
(`--remove-depends-on`, repeatable), or cleared (`--clear-depends-on`).

**`batch-edit --project <name> --task-ids <ids> [fields...]`**

Apply the same edit to multiple tasks. `--task-ids` takes a comma-separated
list of hex IDs. Same field options as `edit`.

**`decompose --project <name> (--task-id <id> | --task <text>) --subtasks-file <path> [--dry-run]`**

Replace a task with subtasks defined in a JSON file. Use `-` for stdin.
`--dry-run` previews without executing.

### Lock commands

The project lock system prevents concurrent edits to TASKS.yaml. Each lock
has a fixed 20-minute TTL.

**`lock-acquire --project <name> [--force] [--note <text>] [--json]`**

Acquire a project lock. Identifies the owner via `git config user.email` or
`$USER`. `--force` steals the lock from another owner.

**`lock-release --project <name> [--force] [--json]`**

Release a project lock. Only the lock owner (or `--force`) can release.

**`lock-status [--project <name>] [--json]`**

Show lock status. Without `--project`, lists all projects.

**`lock-force-release --project <name> [--json]`**

Force-release a project lock regardless of owner.

### Maintenance commands

**`assign-ids [--project <name>]`**

Auto-assign 4-character hex IDs to tasks missing one. Requires project lock.

**`validate`**

Validate all task IDs across all projects. Checks for duplicate IDs and
malformed entries. Does not modify files.

**`stop --task-id <id> [--dry-run]`**

Kill a dispatched task process. `--task-id` can be a dispatch ID (e.g.
`dispatch_abc123`) or a task hash. `--dry-run` shows what would be killed
without executing. The kill is forwarded to the remote client via the
daemon webhook.

### Common options

| Flag | Description |
|---|---|
| `--project <name>` | Project name (required for most write commands) |
| `--task-id <id>` | Task hash ID (4-char hex) |
| `--task <text>` | Lookup by task text (fuzzy alternative to `--task-id`) |
| `--base-dir <path>` | Cortex root directory (default: `~/Cortex`) |
| `--json` | Output as JSON (read commands and lock operations) |
| `--help` | Show command help |

### Task lifecycle states

```
open → claimed → done
  ↓        ↓
paused   pending → open (reopen)
  ↓
blocked → open (unblock)

approval states: request-approval → approve → clear-approval
```

Both `block`/`unblock` and `reopen` normalize a task's status back to `open`, so a
task that failed mid-`cortex-run` (left as `pending`) returns to a dispatchable
state rather than staying invisible to the dispatcher.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Error (invalid arguments, lock held by another, task not found) |

---

## cortex-run

```
cortex-run [options] -- COMMAND [ARGS...]
```

Dispatch a command on a remote device via the Cortex daemon. All execution
is forwarded through `sendCommand` to a cortex-client; nothing spawns
locally. The daemon must be running (it serves the webhook on
`127.0.0.1:3001`). For scheduling recurring runs, see
[scheduling.md](./scheduling.md). For thread-based execution, see
[threads.md](./threads.md).

### Launch mode

```
cortex-run [--device <name>] --name <name> [--stall 10m] [--gpu auto]
           [--task-project P --task-id ABCD] [--force]
           [--env-passthrough VAR1,VAR2,...]
           [--log-tail-bytes 5000]
           -- COMMAND [ARGS...]
```

Options:
- `--name <name>` — required, unique run name (also used as result directory)
- `--device <name>` — target device (default: local machine name from `machines.json`)
- `--stall <duration>` — stall timeout, e.g. `10m`, `1h` (default: `10m`)
- `--gpu <slot>` — GPU slot: `auto`, `none`, or numeric index (default: `auto`)
- `--force` — allow launch even if a same-name run state directory exists
- `--task-project <name>` — link this run to a project for task lifecycle tracking
- `--task-id <hash>` — 4-char hex task ID (used with `--task-project`); invalid IDs cause a non-zero exit before dispatch
- `--env-passthrough <list>` — comma-separated env var names to forward to the remote
- `--log-tail-bytes <n>` — bytes of log tail returned in callback (default: 5000)

The `--` separator is required. Everything after it is the command to run
on the remote device.

When `--task-project` and `--task-id` are provided, `cortex-run` marks the
task as pending before dispatch and defers completion/blocking to the
client callback handler. On success the task is auto-completed; on failure
it is auto-blocked with log tail context.

### Cancel mode

```
cortex-run --cancel <name> [--device <name>] [--signal SIGTERM]
```

Options:
- `--cancel <name>` — run name to cancel
- `--device <name>` — target device (default: local machine name)
- `--signal <sig>` — signal to send (default: `SIGTERM`)

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Success (launched or cancelled) |
| 1 | Fatal error (invalid task-id, device offline, launch/cancel failed) |
| 2 | Usage error (missing required flag, no command after `--`) |

### Examples

```bash
# Launch a training script on the local machine
cortex-run --name train-v2 --gpu auto -- python train.py --epochs 100

# Launch with task linkage (auto-completes task on success)
cortex-run --name eval-run --task-project my-project --task-id a1b2 -- python eval.py

# Launch on a remote device with env passthrough
cortex-run --device lab --name remote-train --env-passthrough WANDB_API_KEY,HF_TOKEN -- python train.py

# Cancel a running job
cortex-run --cancel train-v2

# Cancel with a specific signal
cortex-run --cancel train-v2 --signal SIGKILL
```
