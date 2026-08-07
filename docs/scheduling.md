# Cortex Scheduling System

The scheduling system lets you set up recurring or one-time agent invocations. Schedules persist to disk, survive restarts, and hot-reload when changed externally. Daemon infrastructure loops such as task dispatch, task archiving, and memory-index rebuild use the built-in job controller described below rather than schedule records.

## Schedule Types

Four trigger types are supported:

| Type | Description | Key Parameter | Example |
|------|-------------|---------------|---------|
| `interval` | Fire every N time units | `interval` (e.g., `"5m"`, `"1h"`, `"30s"`) | Run a status check every 5 minutes |
| `daily` | Fire at a specific time each day | `time` (`HH:MM` 24-hour format) | Run a daily digest at 09:00 |
| `weekly` | Fire on a specific day of week at a time | `dayOfWeek` (0-6, 0=Sun), `time` | Run a weekly review Monday at 21:00 |
| `once` | Fire once after a delay | `delay` (duration string or ms) | Send a reminder in 2 hours |

Duration strings follow the format `<number><unit>` where unit is `s` (seconds), `m` (minutes), `h` (hours), or `d` (days). Examples: `"30s"`, `"5m"`, `"2h"`, `"1d"`.

## Schedule Records

Each schedule is stored as a JSON object in `~/.cortex/data/schedules.json`:

```json
{
  "tasks": [
    {
      "id": "d6f1bb1e",
      "type": "interval",
      "message": "Check the active projects and report blockers",
      "projectId": "general",
      "profile": "claude-haiku",
      "intervalMs": 3600000,
      "createdAt": 1747680000000,
      "nextRun": 1747683600000,
      "lastRun": 1747680000000,
      "target": { "kind": "fresh" },
      "fallback": "fresh"
    }
  ]
}
```

### ScheduleTask Fields

| Field | Description |
|-------|-------------|
| `id` | 8-character hex identifier (auto-generated) |
| `type` | `interval`, `daily`, `weekly`, or `once` |
| `message` | The prompt to send when the schedule fires (a `[Scheduled Task]` prefix is added automatically at fire time) |
| `projectId` | Project associated with the schedule and its fallback destination |
| `profile` | Agent profile name (defaults to the active profile) |
| `intervalMs` | For `interval` type: milliseconds between fires |
| `time` | For `daily`/`weekly` types: `HH:MM` 24-hour time |
| `dayOfWeek` | For `weekly` type: 0-6 (0=Sunday) |
| `runAt` | For `once` type: epoch milliseconds when to fire |
| `nextRun` | Computed epoch ms of next scheduled fire |
| `createdAt` | Epoch ms when the schedule was created |
| `lastRun` | Epoch ms of last successful fire |
| `lastSkipped` | Epoch ms of last skipped fire (preCheck failed) |
| `isPaused` | Whether the schedule is currently paused |
| `pausedAt` | Epoch ms when paused |
| `pausedBy` | `"user"` or `"rate-limit"` — who paused it |
| `dispatchType` | Reserved internal handler key; ordinary user schedules omit it |
| `preCheck` | Optional shell command; non-zero exit → skip this fire |
| `target` | Where the fired task should land (see Target Resolution below) |
| `fallback` | What to do if target is unavailable: `"fresh"` (default), `"skip"`, or `"wait"` |

## Built-in periodic jobs

Task dispatch, completed-task archival, and memory-index rebuild are daemon-owned jobs. They do not appear in `schedules.json`, `!schedule list`, the schedule CLI, or the Web schedule list. Their switches and intervals are configured under **Settings → Advanced → Built-in jobs** or with these `config/settings.json` pairs: `taskDispatchEnabled` / `taskDispatchIntervalMs`, `taskArchiveEnabled` / `taskArchiveIntervalMs`, and `memoryIndexRegenEnabled` / `memoryIndexRegenIntervalMs`.

Enabled jobs run once when the daemon starts. Settings edits hot-reload: disabling a job clears its next timer, enabling it runs immediately, and changing an interval reschedules the next idle run. See [configuration.md](./configuration.md#configsettingsjson) for defaults and bounds.

## Target Resolution

The `target` field controls **where** the scheduled task lands when it fires:

| Target Shorthand | Behavior |
|-----------------|----------|
| `fresh` | Always create a new thread (default). The schedule's channel is used as fallback |
| `current-channel` | Reuse the channel's active thread if one exists; otherwise create a default thread with the channel's session |
| `current-session` | Resume a specific named session (`cortex-XXXX`). If the session is gone, apply fallback |
| `current-thread` | Continue a specific thread by ID. If the thread is gone or not running/waiting, apply fallback |

The `current-channel`, `current-session`, and `current-thread` shorthands are resolved to concrete IDs at **create time** from the current execution context. Explicit target objects can also be used:

```json
{ "kind": "fresh" }
{ "kind": "channel", "channel": "C07ABCDEF" }
{ "kind": "session", "sessionName": "cortex-a1b2c3", "sessionId": "sess_xyz", "channel": "C07ABCDEF" }
{ "kind": "thread", "threadId": "thr_a1b2c3d4", "channel": "C07ABCDEF" }
```

## Fallback Behavior

When a `session` or `thread` target is no longer available at fire time, the `fallback` field determines what happens:

| Fallback | Behavior |
|----------|----------|
| `fresh` | Silently fall back to creating a new thread in the schedule's channel (default) |
| `skip` | Record `lastSkipped`, post a one-line Slack note, do not run the task |
| `wait` | Not yet implemented — currently treated as `fresh` |

## PreCheck

The `preCheck` field is an optional shell command that acts as a gate: if the command exits with a non-zero status, the schedule's fire is **skipped** for that cycle. The schedule is rescheduled for its next normal interval — there is no fast retry.

The command runs via `execSync` with a 15-second timeout. It receives the `PRECHECK_LAST_RUN` environment variable (epoch ms of the task's `lastRun` field). The working directory is `DATA_DIR` (`~/.cortex/`).

**Use cases for preCheck:**

- Check if a required file exists before running: `test -f ~/.cortex/data/schedules.json`
- Check if a process is running: `pgrep -f "python train.py"`
- Check system load: `[ $(cat /proc/loadavg | cut -d' ' -f1 | cut -d. -f1) -lt 8 ]`

## Hot-Reload

The scheduler watches `schedules.json` for external changes via `fs.watch`. When a change is detected (after a 300ms debounce), it:

1. Invalidates the in-memory cache
2. Reads the fresh file from disk
3. Diffs file task IDs against in-memory timer IDs
4. **Removes** timers for tasks no longer in the file
5. **Adds** timers for new tasks
6. **Updates** timers for tasks whose scheduling config changed (detected via config hash comparison)
7. Sends an admin notification to Slack: `:arrows_counterclockwise: schedules.json hot-reloaded: +N -M ~P task(s)`

**Self-write guard:** When the scheduler itself writes to `schedules.json` (via `add`, `remove`, `pause`, etc.), it sets a `_selfWriting` flag for 100ms. The file watcher ignores changes during this window to avoid redundant hot-reloads.

### Config Hash for Change Detection

Each task's scheduling-relevant fields are hashed: `type`, type-specific key (intervalMs/time/dayOfWeek), message, channel, profile, dispatchType, preCheck. If the hash of a task in the file differs from the in-memory hash, the timer is re-armed. This means edits to any scheduling field trigger an automatic re-schedule.

## Before-Run Guard

In addition to `preCheck` (which is per-task), the scheduler supports a global `beforeRunGuard` callback set by `app.ts`. This guard is used for system-wide concerns like rate-limit throttling. When the guard returns `true`, the fire is blocked entirely. The `_onGuardBlocked` async callback handles bookkeeping (e.g., persisting the throttle state).

## In-Flight Protection

Each task has an `_inFlight` flag. If a task's timer fires while a previous invocation is still running (detected because the task ID is in `_inFlight`), the new invocation is skipped. This prevents overlapping executions of the same schedule.

## Pause and Resume

### Pausing

Schedules of type `interval`, `daily`, and `weekly` can be paused. Once-type schedules cannot be paused (they either fire or get dropped).

When paused:
- `isPaused` is set to `true`, `pausedAt` records the timestamp, `pausedBy` records `"user"` or `"rate-limit"`
- `nextRun` is set to `null`
- The in-memory timer is cleared and not re-armed

The `pausedBy` field distinguishes user-initiated pauses from automatic rate-limit pauses. The rate-limit auto-resume path only considers `pausedBy: "rate-limit"` tasks.

### Resuming

When resumed:
- `isPaused` is set to `false`, `pausedAt` and `pausedBy` are cleared
- `nextRun` is recomputed based on the schedule type (for `interval`: `now + intervalMs`; for `daily`/`weekly`: the next occurrence)
- The timer is re-armed

### Removing

Schedules can be deleted by ID (idempotent — removing a non-existent schedule returns `{ removed: false }`). The timer is cleared and the entry is removed from `schedules.json`.

## Startup Behavior

On server startup, the scheduler:

1. Drops `once` tasks that are more than 1 minute overdue (past their `runAt`)
2. Schedules all remaining tasks with their computed `nextRun` times
3. Starts the file watcher for hot-reload
4. Logs the total task count

## MCP Tools

Schedules can be managed through MCP tools (used by the agent in Slack conversations):

| Tool | Description |
|------|-------------|
| `cortex_schedule_add` | Create a new schedule. Accepts `type`, `message`, `interval`/`time`/`dayOfWeek`/`delay`, `target`, `fallback`, `profile`, `preCheck` |
| `cortex_schedule_list` | List all schedules (default: 50) |
| `cortex_schedule_get` | Get a schedule by ID |
| `cortex_schedule_remove` | Delete a schedule by ID (idempotent) |
| `cortex_schedule_pause` | Pause a recurring schedule |
| `cortex_schedule_resume` | Resume a paused schedule |

The `cortex_context` MCP tool provides the current execution context (channel, sessionId, sessionName, threadId, profile, project, backend) that `cortex_schedule_add` uses for `current-channel`/`current-session`/`current-thread` target resolution.

### Creating a Schedule via MCP

```json
{
  "type": "interval",
  "message": "Check GPU status and report",
  "interval": "10m",
  "target": "current-channel",
  "fallback": "fresh"
}
```

```json
{
  "type": "daily",
  "message": "Run morning research scan",
  "time": "08:00",
  "profile": "claude-sonnet"
}
```

## Slack Commands

The `!schedule` Slack command provides interactive schedule management.
For the underlying CLI tools, see [cli-reference.md](./cli-reference.md).

| Command | Description |
|---------|-------------|
| `!schedule list` | List all schedules with status, next run time, and type |
| `!schedule add <type> <message>` | Add a new schedule interactively |
| `!schedule remove <id>` | Remove a schedule |
| `!schedule pause <id>` | Pause a schedule |
| `!schedule resume <id>` | Resume a paused schedule |

## Execution routing

Ordinary schedule records use the `scheduled-task` runner and send their message to an agent with the `[Scheduled Task]` prefix. A small set of shipped schedules may use reserved internal handler keys, but unregistered `dispatchType` values are skipped rather than interpreted as agent prompts. Daemon-owned periodic infrastructure uses `builtin-jobs.ts` and is not routed through schedule persistence.

## Rate-Limit Integration

The scheduler integrates with Cortex's rate-limit throttling:

- The `beforeRunGuard` callback can block fires when the system is rate-limited
- Schedules can be auto-paused by the rate-limit system (`pausedBy: "rate-limit"`)
- The throttle state (`resetsAt`, `activatedAt`, affected modes) is stored in `schedules.json` alongside tasks
- On startup, previously rate-limit-paused tasks are evaluated for auto-resume
