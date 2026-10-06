---
name: schedule
description: "Use when create, list, or manage scheduled or recurring tasks"
allowed-tools: Read, Bash, mcp__cortex-core__cortex_context, mcp__cortex-core__cortex_schedule_add, mcp__cortex-core__cortex_schedule_list, mcp__cortex-core__cortex_schedule_get, mcp__cortex-core__cortex_schedule_remove, mcp__cortex-core__cortex_schedule_pause, mcp__cortex-core__cortex_schedule_resume
metadata:
  author: "Cortex"
  version: "2.0.0"
  date: "2026-10-05"
---

# Schedule

You are Cortex, managing scheduled tasks.

## Arguments
$ARGUMENTS

A scheduled task sends a message to Cortex at set times — a recurring GPU check, a daily roundup, a delayed reminder. Each fire opens a new session in the schedule's project and sends it the message with a `[Scheduled Task]` prefix. That session knows nothing about the conversation that created the schedule, so the message must be self-contained: name the run, machine, log path or file it should look at.

Every schedule has:

- **type** — `interval` (every N: `30s`, `5m`, `2h`, `1d`), `daily` (`HH:MM`, 24-hour), `weekly` (day + `HH:MM`), or `once` (after a delay; removed after it fires)
- **projectId** — the project the fired session runs in (`general` when none is given)
- **profile** — the agent profile it runs under (the default profile when none is given)
- **preCheck** *(optional)* — a shell command run before each fire; a non-zero exit skips that fire

Durations always carry a unit (`90m`, not `90`). Schedules live in `$CORTEX_HOME/data/schedules.json`; a running daemon picks up every change within a second, so never restart it and never edit the file by hand.

## MCP tools (inside an agent session)

```
mcp__cortex-core__cortex_schedule_add({
  type: 'interval' | 'daily' | 'weekly' | 'once',
  message: 'self-contained prompt',
  interval?: '30m',            // interval
  time?: '09:00',              // daily, weekly
  dayOfWeek?: 'mon' | 0-6,     // weekly (0 = Sun)
  delay?: '2h',                // once
  projectId?: 'nimbus',
  target?: 'current-project',  // same as projectId = this session's project
  profile?: 'fast-worker',
  preCheck?: 'test -f /tmp/run.done',
})
mcp__cortex-core__cortex_schedule_list({ limit? })
mcp__cortex-core__cortex_schedule_get({ id })
mcp__cortex-core__cortex_schedule_pause({ id })    // recurring only
mcp__cortex-core__cortex_schedule_resume({ id })   // recurring only
mcp__cortex-core__cortex_schedule_remove({ id })
```

The project is resolved in this order: `projectId`, then `target: 'current-project'`, then the project the current channel belongs to, then `general`. `current-project` fails when the session has no project; pass `projectId` or leave both out instead.

To change an existing schedule's timing, message, project or profile, use `cortex schedule edit` below.

## `cortex schedule` (shell)

Use it for edits, for scripts, and outside an agent session. Every command prints JSON with `ok`, the schedule id and ISO timestamps; invalid input exits 1 with the valid values.

```bash
cortex schedule list [--project <id>]
cortex schedule get <id>
cortex schedule add --type interval --interval 30m --message "..." [--project <id>] [--profile <name>] [--pre-check "<cmd>"] [--idempotency-key <key>]
cortex schedule add --type daily --time 09:00 --message "..."
cortex schedule add --type weekly --day mon --time 21:00 --message "..."
cortex schedule add --type once --delay 2h --message -        # message from stdin
cortex schedule edit <id> [--message ...] [--project ...] [--profile ...] [--pre-check ...] [--interval ... | --time ... | --day ... | --delay ...]
cortex schedule pause <id>
cortex schedule resume <id>
cortex schedule remove <id> [--dry-run]
```

`edit` accepts only the timing flags of the schedule's own type; `--delay` on a `once` schedule moves it to that long from now. With `--idempotency-key`, retrying an `add` returns the schedule already created under that key. `remove` of an unknown id succeeds with `"removed": false`. `cortex schedule --help` lists every flag with examples.

## Workflow

1. **List** (no arguments, or "show my schedules"): call `cortex_schedule_list` and summarize id, type, timing, project, next run and paused state.
2. **Add**: turn the request into type, timing, project and a self-contained message, then call `cortex_schedule_add`. For example:
   - "Check GPU status every 30 minutes" → interval `30m`, "Run nvidia-smi on lab2 and report a one-line summary of GPU use"
   - "Roundup of this project every morning at 9" → daily `09:00`, `target: 'current-project'`, "Review STATUS.md and roadmap.md for this project and post a short roundup"
   - "Mine last week's sessions every Monday at 9 PM" → weekly `mon` `21:00`, "Read this week's session logs and record any recurring failure or lesson worth keeping"
   - "Report on training in 2 hours" → once `2h`, `target: 'current-project'`, "Check training run r42 on lab2 (log at /data/r42/train.log) and report whether it is still healthy"
3. **Change, pause, resume, remove**: find the id with `cortex_schedule_list` when the user did not give it, then use the matching tool or `cortex schedule edit`.
4. **Report**: state what changed, the schedule id, and when it fires next.

```
Scheduled: every 30m — "Run nvidia-smi on lab2 and report a one-line summary"
id: `a1b2c3d4` | project: nimbus | first run: 14:30
```

Users can also manage schedules from chat with `!schedule` and from the Schedules panel in the web app.
