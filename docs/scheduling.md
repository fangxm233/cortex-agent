# Cortex Scheduling System

The scheduling system lets you set up recurring or one-time agent invocations. Schedules persist to disk, survive restarts, and hot-reload when changed externally. Each fire opens a new session that runs the schedule's prompt. Daemon infrastructure loops such as provider-usage collection and memory-index rebuild use the built-in job controller described below rather than schedule records.

!!! tip "Waiting for something to finish? Do not schedule a poll"
    A schedule that fires only to check whether a job is done costs a full agent
    turn every time, and almost every one of those turns finds nothing. Arm a
    [waitpoint](./waitpoints.md) instead: the job reports back when it finishes and
    the session wakes exactly once. Schedules are for work that should happen on a
    clock, not for watching something else.

## Schedule Types

Four trigger types are supported:

| Type | Description | Key Parameter | Example |
|------|-------------|---------------|---------|
| `interval` | Fire every N time units | `interval` (e.g., `"5m"`, `"1h"`, `"30s"`) | Run a status check every 5 minutes |
| `daily` | Fire at a specific time each day | `time` (`HH:MM` 24-hour format) | Run a daily digest at 09:00 |
| `weekly` | Fire on a specific day of week at a time | `dayOfWeek` (0-6, 0=Sun), `time` | Run a weekly review Monday at 21:00 |
| `once` | Fire once after a delay | `delay` (duration string) | Send a reminder in 2 hours |

Duration strings follow the format `<number><unit>` where unit is `s` (seconds), `m` (minutes), `h` (hours), or `d` (days). Examples: `"30s"`, `"5m"`, `"2h"`, `"1d"`. A bare number in a string is rejected, so `"30"` never turns into 30 milliseconds; callers that pass JSON numbers (the MCP tools, the Web UI) give milliseconds. Weekdays are `sun`..`sat` or `0`-`6`, and times are 24-hour `HH:MM` in the server's local time. The message is trimmed and must not be empty.

## Managing schedules

Every entry point applies the same validation and writes the same `schedules.json`:

| Entry point | Who uses it |
|-------------|-------------|
| MCP tools `cortex_schedule_*` | Agents inside a session (see [MCP Tools](#mcp-tools)) |
| `cortex schedule` | Scripts and terminals (see [CLI](#cli)) |
| `!schedule` | Chat commands in Slack or Feishu (see [Chat commands](#chat-commands)) |
| Web UI / desktop app | The schedule list and editor |

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
      "lastRun": 1747680000000
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
| `projectId` | Project the schedule belongs to; each fire's session opens in it |
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
| `pausedBy` | `"user"` while the schedule is paused |
| `dispatchType` | Reserved internal handler key; ordinary user schedules omit it |
| `preCheck` | Optional shell command; non-zero exit → skip this fire |
| `idempotencyKey` | Set by `cortex schedule add --idempotency-key`; a retry with the same key returns this schedule |

## Built-in periodic jobs

Provider-usage collection and memory-index rebuild are daemon-owned jobs. They do not appear in `schedules.json`, `!schedule list`, `cortex schedule list`, or the Web schedule list. Their switches and intervals are configured under **Settings → Advanced → Built-in jobs** or with these `config/settings.json` pairs: `providerUsageCollectionEnabled` / `providerUsageCollectionIntervalMs` and `memoryIndexRegenEnabled` / `memoryIndexRegenIntervalMs`.

Enabled jobs run once when the daemon starts. Settings edits hot-reload: disabling a job clears its next timer, enabling it runs immediately, and changing an interval reschedules the next idle run. See [configuration.md](./configuration.md#configsettingsjson) for defaults and bounds.

## Where a fire lands

Every fire opens a new, ordinary session — the same kind you start from the Web
UI or the desktop app — and sends the schedule's message, with a
`[Scheduled Task]` prefix, as its first turn. The session is recorded as that
schedule's run and labeled with the start of the message; open it to read the
result or reply as in any other conversation. A fire never reuses an earlier
run's session, so the runs of a recurring schedule stay in separate transcripts.

The session opens in the schedule's `projectId`, which is settled when the
schedule is created: an explicit project wins; otherwise the MCP tool uses the
project named by `target: "current-project"` (the creating session's project),
then the creating channel's registered project, then `general`. `cortex schedule`
and the Web UI take the project directly and default to `general`.

## PreCheck

The `preCheck` field is an optional shell command that acts as a gate: if the command exits with a non-zero status, the schedule's fire is **skipped** for that cycle. The schedule is rescheduled for its next normal interval — there is no fast retry.

The command runs in a shell, off the event loop, with a 15-second timeout. It receives the `PRECHECK_LAST_RUN` environment variable (epoch ms of the task's `lastRun` field). The working directory is `DATA_DIR` (`~/.cortex/`).

**Use cases for preCheck:**

- Check if a required file exists before running: `test -f ~/.cortex/data/schedules.json`
- Check if a process is running: `pgrep -f "python train.py"`
- Check system load: `[ $(cat /proc/loadavg | cut -d' ' -f1 | cut -d. -f1) -lt 8 ]`

## Hot-Reload

The daemon's scheduler is the only process that fires schedules, but it is not the only writer of
`schedules.json`: the MCP schedule tools run in each agent's own MCP server process, and
`cortex schedule` runs in yours. Both write the file directly. The scheduler watches it with
`fs.watch` and, 300ms after the last change:

1. Reads the file from disk, bypassing its in-memory copy
2. **Removes** timers for tasks no longer in the file
3. **Adds** timers for new tasks
4. **Re-arms** tasks whose scheduling config changed (detected via config hash comparison)
5. Sends an admin notification: `:arrows_counterclockwise: schedules.json hot-reloaded: +N -M ~P task(s)`

The scheduler's own writes trigger the watcher too; the reload that follows finds nothing changed
and stays silent. Every write — the daemon's included — re-reads the file inside the write, so a
change another process made a moment earlier is kept rather than overwritten by a stale copy.

### Config Hash for Change Detection

Each task's scheduling-relevant fields are hashed: `type`, the type-specific timing (`intervalMs`, `time`, `dayOfWeek`, `runAt`), `message`, `projectId`, `profile`, `dispatchType`, `preCheck`, and whether it is paused. If the hash of a task in the file differs from the armed one, the timer is re-armed, so an edit, pause, or resume made by any writer takes effect without a restart.

## In-Flight Protection

If a schedule fires while its previous run is still going, the new fire is skipped. This prevents overlapping runs of the same schedule.

## Pause and Resume

### Pausing

Schedules of type `interval`, `daily`, and `weekly` can be paused. Once-type schedules cannot be paused (they either fire or get dropped).

When paused:
- `isPaused` is set to `true`, `pausedAt` records the timestamp, `pausedBy` records `"user"`
- `nextRun` is set to `null`
- The in-memory timer is cleared and not re-armed

A paused schedule stays paused until it is resumed. Pausing a paused schedule, or resuming a running one, changes nothing.

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

Agents manage schedules through MCP tools:

| Tool | Description |
|------|-------------|
| `cortex_schedule_add` | Create a new schedule. Accepts `type`, `message`, `interval`/`time`/`dayOfWeek`/`delay`, `projectId`, `target`, `profile`, `preCheck`, `channel` |
| `cortex_schedule_list` | List all schedules (default: 50) |
| `cortex_schedule_get` | Get a schedule by ID |
| `cortex_schedule_remove` | Delete a schedule by ID (idempotent) |
| `cortex_schedule_pause` | Pause a recurring schedule |
| `cortex_schedule_resume` | Resume a paused schedule |

`target` only chooses the project: `"current-project"` (or `{ "kind": "project", "projectId": "…" }`) binds the schedule to that project, while `"fresh"` or no target leaves it to `projectId`, the channel lookup, or `general`. `current-project` resolves against the same context `cortex_context` returns, and fails when the session has no project.

### Creating a Schedule via MCP

```json
{
  "type": "interval",
  "message": "Check GPU status and report",
  "interval": "10m",
  "target": "current-project"
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

## CLI

`cortex schedule` manages the same schedules from a terminal or script. Every command prints JSON, timing comes from explicit flags, and the long prompt can come from stdin:

```bash
cortex schedule add --type daily --time 09:00 --project nimbus --message "Summarize yesterday's sessions"
echo "Check training run r42 on lab2" | cortex schedule add --type once --delay 2h --message -
cortex schedule list --project nimbus
cortex schedule edit a1b2c3d4 --time 10:30
cortex schedule pause a1b2c3d4
cortex schedule remove a1b2c3d4 --dry-run
```

A running daemon picks the change up within a second. See [cli-reference.md](./cli-reference.md) for every option.

## Chat commands

The `!schedule` command manages schedules from Slack or Feishu. A schedule added here belongs to the channel's registered project, or `general`.

| Command | Description |
|---------|-------------|
| `!schedule` / `!schedule list` | List all schedules with status, next run time, and pause/resume/remove buttons |
| `!schedule add interval <duration> [--profile <name>] <message>` | Repeat every duration |
| `!schedule add daily <HH:MM> [--profile <name>] <message>` | Run every day at a time |
| `!schedule add weekly <day> <HH:MM> [--profile <name>] <message>` | Run every week on a day |
| `!schedule add once <duration> [--profile <name>] <message>` | Run once after a delay |
| `!schedule pause <id>` | Pause a recurring schedule |
| `!schedule resume <id>` | Resume a paused schedule |
| `!schedule remove <id>` | Remove a schedule |

## Execution routing

Ordinary schedule records use the `scheduled-task` runner, which opens a new session for each fire and sends the message with the `[Scheduled Task]` prefix. A small set of shipped schedules may use reserved internal handler keys, but unregistered `dispatchType` values are skipped rather than interpreted as agent prompts. Daemon-owned periodic infrastructure uses `builtin-jobs.ts` and is not routed through schedule persistence.

## Rate limits

When every configuration of a schedule's profile is rate-limited, the fire is skipped and the schedule keeps its timing: it fires again at its next time. A run that hits a rate limit after it has started is paused and resumed like any other session.
