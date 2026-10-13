---
name: schedule
description: "Use when creating, listing, or managing scheduled or recurring tasks"
allowed-tools: Read, Bash, mcp__cortex-core__cortex_context
metadata:
  author: "Cortex"
  version: "3.0.0"
  date: "2026-10-06"
---

# Schedule

## Arguments
$ARGUMENTS

Manage schedules with `cortex schedule` through Bash. Each fire opens a new session in the schedule's project and sends the message with a `[Scheduled Task]` prefix. Write a self-contained message: identify the project, run, machine, and files to inspect; the new session does not know this conversation.

Schedules are for work on a clock. To wait for a job to finish, use a waitpoint and a completion callback, not a scheduled poll.

## Scope and timing

- **Project:** use the user's explicit project when given. Otherwise use the session's project from the supplied session context or `cortex_context`, and pass `--project <id>` explicitly when adding a schedule. For a request scoped to the current project, if no project is available, ask which project to use; do not silently choose `general`. For an explicitly unscoped schedule, use `--project general`. The CLI itself defaults to `general`; it does not infer the session or channel. Do not rely on `$CORTEX_PROJECT` or other session environment variables being present in Bash (including PI sessions).
- **Profile:** omit `--profile` unless the user chooses one. The configured default profile applies, not necessarily this session's active profile.
- **Time:** daily/weekly `--time HH:MM` and `--day` use the server's local timezone. Establish the server timezone (including any daemon `TZ` override) and explicitly convert requests in the user's timezone before passing flags, adjusting the weekday if needed. Report the next run in the user's timezone with its timezone label. There is no per-schedule timezone option; differing daylight-saving transitions can shift a recurring schedule in the user's timezone. Explain that limitation rather than promising timezone-aware recurrence; clarify when the intended conversion is uncertain.
- **Durations:** use units: `30s`, `5m`, `2h`, `1d` (not `90`). Types are `interval`, `daily`, `weekly`, and `once`. A `once` schedule is removed after firing and cannot be paused or resumed.
- **Pre-check:** optional `--pre-check` runs a shell command before each fire; non-zero exit skips that fire. It has a 15-second timeout and receives `PRECHECK_LAST_RUN` (epoch milliseconds).

## CLI

Run on the Cortex server with its `CORTEX_HOME`. Commands return JSON with `ok`, schedule data and ISO timestamps; invalid input exits non-zero. `cortex schedule --help` lists flags and examples.

```bash
cortex schedule list [--project <id>]
cortex schedule get <id>
cortex schedule add --type interval --interval 30m --project <id> --message "..." [--profile <name>] [--pre-check "<cmd>"] [--idempotency-key <key>]
cortex schedule add --type daily --time 09:00 --project <id> --message "..."
cortex schedule add --type weekly --day mon --time 21:00 --project <id> --message "..."
cortex schedule add --type once --delay 2h --project <id> --message -
cortex schedule edit <id> [--message ...] [--project ...] [--profile ...] [--pre-check ...] [--interval ... | --time ... | --day ... | --delay ...]
cortex schedule pause <id>
cortex schedule resume <id>
cortex schedule remove <id> [--dry-run]
```

`--message -` reads the prompt from stdin. `edit` accepts only timing flags for the existing schedule's type; `--delay` moves a `once` schedule to that long from now. Use a stable `--idempotency-key` for an add that might be retried; reuse it only for that intended creation. `remove --dry-run` previews deletion. Removing an unknown id succeeds with `"removed": false`.

Schedules persist in `$CORTEX_HOME/data/schedules.json`. The running daemon picks up changes within a second; do not restart it or edit the file by hand.

## Workflow

1. **List:** use `cortex schedule list`, adding `--project <id>` for a project-scoped request. Summarize id, type, timing, project, next run and paused state.
2. **Add:** resolve project and timing above; prepare a self-contained message, then use `cortex schedule add`. Example after resolving the project as `nimbus`:
   ```bash
   cortex schedule add --type once --delay 2h --project nimbus \
     --message "Check training run r42 on lab2 (log /data/r42/train.log) and report whether it is healthy" \
     --idempotency-key nimbus-r42-health-check
   ```
3. **Edit, pause, resume, remove:** find the id with `list` if missing, inspect it with `get` when needed, and use the corresponding CLI command. Preserve the existing project/profile unless the user requests a change. Preview a removal with `--dry-run` before deleting.
4. **Report:** state the change, schedule id, project and next run in the user's timezone. Do not claim success if the command failed.

Users can also manage schedules with `!schedule` in chat and the Schedules panel in the web app.
