---
name: schedule
description: "Use when create, list, or manage scheduled or recurring tasks"
allowed-tools: Read, Write, Edit, Bash, mcp__cortex__cortex_context, mcp__cortex__cortex_schedule_add, mcp__cortex__cortex_schedule_list, mcp__cortex__cortex_schedule_get, mcp__cortex__cortex_schedule_remove, mcp__cortex__cortex_schedule_pause, mcp__cortex__cortex_schedule_resume
metadata:
  author: "Cortex"
  version: "1.1.0"
  date: "2026-04-27"
---

# Schedule

You are Cortex, managing the scheduled task system.

## Arguments
$ARGUMENTS

Scheduled tasks allow Cortex to automatically execute messages at set times — like a recurring GPU check, daily standup, or delayed reminder. Tasks persist in `agent-server/schedules.json` and survive daemon restarts.

**Task types:**
- `interval` — repeat every N duration (30s / 5m / 2h / 1d)
- `daily` — every day at a fixed time (HH:MM, 24-hour)
- `weekly` — every week at a fixed day + time (`mon 21:00`)
- `once` — run once after a delay, then auto-removed

**Targets (where the fired task lands):**
- `fresh` *(default)* — new isolated thread + new session (current behavior; safest for unrelated tasks)
- `current-project` — spawn a fresh session in the project (default for project-addressed schedules)
- `current-thread` — continue the current thread (only valid while it's running/waiting)

`current-*` shorthand resolves to concrete IDs at create time, so `cortex_schedule_list` always shows real IDs.

---

## Preferred Path — MCP Tools (LLM-driven)

When you (the LLM) need to add or manage schedules from inside an agent session, use these MCP tools — they're more reliable than shelling out to `bin/schedule` (no quoting issues, no working-dir confusion):

```
mcp__cortex__cortex_context()
  → { sessionId, sessionName, threadId, profile, project, backend, ... }

mcp__cortex__cortex_schedule_add({
  type: 'interval' | 'daily' | 'weekly' | 'once',
  message: 'prompt to fire',
  interval?: '30m' | '2h' | ...,            // for interval
  time?: '09:00',                            // for daily/weekly
  dayOfWeek?: 'mon' | 0-6,                   // for weekly
  delay?: '2h' | '90m',                      // for once
  target?: 'fresh' | 'current-project' | 'current-thread' | { kind, ... },
  fallback?: 'fresh' | 'skip' | 'wait',      // when target thread is gone at fire time
  profile?: 'fast-worker',
  channel?: 'C123',                          // override; defaults to current context
})
mcp__cortex__cortex_schedule_list({ limit? })
mcp__cortex__cortex_schedule_get({ id })
mcp__cortex__cortex_schedule_remove({ id })
mcp__cortex__cortex_schedule_pause({ id })   // recurring only
mcp__cortex__cortex_schedule_resume({ id })
```

**Worked examples:**

> User: "Remind me to run /orient every morning at 9, send results to current channel"
>
> Call `mcp__cortex__cortex_schedule_add({ type: 'daily', time: '09:00', message: '/orient', target: 'current-project' })` — done. No need to call `cortex_context` first; the shorthand resolves automatically.

> User: "Report training status in this thread after 30 minutes"
>
> Call `mcp__cortex__cortex_schedule_add({ type: 'once', delay: '30m', message: 'Check training results on <machine> and report', target: 'current-thread' })` — the schedule continues the current thread (valid while it is running/waiting), so prior context is intact.

> User: "Run deep retrospective every Monday at 9 PM"
>
> Call `mcp__cortex__cortex_schedule_add({ type: 'weekly', dayOfWeek: 'mon', time: '21:00', message: '/deep-retrospective' })` — `target` defaults to `fresh`, which is the right choice for a standalone weekly job.

If `current-thread` is requested but the context lacks the field, the tool throws — it does NOT silently fall back to fresh. Re-issue with `target: 'fresh'` if that's actually what you want.

---

## Canonical CLI Usage

The canonical CLI usage is:

```bash
npx tsx agent-server/src/schedule-cli.ts --help
npx tsx agent-server/src/schedule-cli.ts list
npx tsx agent-server/src/schedule-cli.ts get <id>
npx tsx agent-server/src/schedule-cli.ts set interval <id> <duration|ms>
npx tsx agent-server/src/schedule-cli.ts edit|update <id> [--message <text>] [--profile <name>] [--channel <name>] [--time <HH:MM>] [--day <0-6|sun|mon|tue|wed|thu|fri|sat>] [--run-at <epoch-ms>] [--interval <duration|ms>]
npx tsx agent-server/src/schedule-cli.ts pause <id>
npx tsx agent-server/src/schedule-cli.ts resume <id>
npx tsx agent-server/src/schedule-cli.ts remove <id> [--dry-run]
npx tsx agent-server/src/schedule-cli.ts add interval <duration|ms> <message>
npx tsx agent-server/src/schedule-cli.ts add daily <HH:MM> <message>
npx tsx agent-server/src/schedule-cli.ts add weekly <day> <HH:MM> <message>
npx tsx agent-server/src/schedule-cli.ts add once <duration|ms> <message>
# Flag-mode add (alternative):
npx tsx agent-server/src/schedule-cli.ts add --type interval --interval 30m --message "Check GPU status"
npx tsx agent-server/src/schedule-cli.ts add --type daily --time 09:00 --message "Daily standup" --channel slack
```

**New CLI features:**
- `--help`: Full usage reference with copyable examples
- `remove --dry-run`: Preview which task would be removed without deleting
- Flag-mode `add`: All parameters via explicit flags (backward-compatible with positional mode)
- Error messages list valid values (e.g., unknown type → shows `interval, daily, weekly, once`)

Use the CLI when the MCP tools above are unavailable (e.g. running outside an agent session, terminal scripting, debugging).

---

## Step 1: Read Current State

Read current schedule state via the canonical schedule CLI from the current repo root (for example `npx tsx agent-server/src/schedule-cli.ts list`). If the file is missing or empty, treat as `{ "tasks": [] }`.

---

## Step 2: Determine Action

Parse `$ARGUMENTS` to choose a path:

### Path A — List / No Arguments

Use the canonical schedule CLI to list tasks and return its JSON output directly: `npx tsx agent-server/src/schedule-cli.ts list`.

If there are no tasks, the JSON result should be `{ "tasks": [] }`.

Stop after sending — no restart needed.

---

### Path B — Add a Task

Interpret the user's natural language description to determine:
- **type**: interval / daily / weekly / once
- **timing**: duration string, HH:MM time, or `<day> HH:MM`
- **message**: a self-contained instruction Cortex will execute when the task fires

**Interpretation examples:**
- "Check GPU status every 30 minutes" → interval, 30m, "Check GPU status (nvidia-smi) and report a one-line summary"
- "Generate a daily project report every morning at 9" → daily, 09:00, "Generate a brief daily status report for all active projects"
- "Do retrospection every Monday at 9 PM" → weekly, mon 21:00, "Execute /deep-retrospective — weekly knowledge mining"
- "Remind me to check training results in 2 hours" → once, 2h, "Check training results on <machine> and report to user"

**Compute the new task object** using the canonical schedule CLI add command. The CLI currently defaults `channel` to `cli` unless an explicit channel override is provided.

Examples:
- `npx tsx agent-server/src/schedule-cli.ts add interval 30m "Check GPU status on <machine> (nvidia-smi) and report a one-line summary"`
- `npx tsx agent-server/src/schedule-cli.ts add daily 09:00 "Generate a brief daily status report for all active projects"`
- `npx tsx agent-server/src/schedule-cli.ts add weekly mon 21:00 "Execute /deep-retrospective — weekly knowledge mining"`
- `npx tsx agent-server/src/schedule-cli.ts add once 2h "Check training results on <machine> and report to user"`

Confirm the plan in the output before writing, showing:
- Task type and timing
- The message that will execute
- When it will first fire

Then write the file and proceed to Step 3.

---

### Path C — Remove a Task

Find the task with the matching id via the canonical schedule CLI and remove it with `npx tsx agent-server/src/schedule-cli.ts remove <id>`.

If not found, output: `:x: Task \`<id>\` not found.`

Proceed to Step 3 if a task was removed.

---

## Step 3: Report Result

The scheduler automatically watches `agent-server/schedules.json` for changes and hot-reloads timers — no daemon restart needed.

Output a confirmation:

**After add:**
```
Scheduled: every 30m — "Check GPU status on <machine>"
id: `a1b2c3d4` | first run: in 30m
```

**After remove:**
```
Removed task `a1b2c3d4`.
```

---

## Notes

- `channel` follows the canonical CLI behavior: if no explicit override is provided, new tasks default to `cli`
- Task messages should be self-contained: Cortex will receive them with the prefix `[Scheduled Task]` and must be able to act without prior context
- For daily tasks, `nextRun` = current epoch ms + ms until next HH:MM occurrence (if time has passed today, add 24h)
- For weekly tasks, store both `dayOfWeek` (`0=Sun ... 6=Sat`) and `time`, and compute `nextRun` from the next matching occurrence
- Inside this skill, prefer the canonical schedule CLI / scheduler API path rather than editing `agent-server/schedules.json` directly. The user-facing `!schedule` command remains a separate shortcut handled by the command layer.
- Do not restart the daemon after schedule changes — the scheduler hot-reloads `agent-server/schedules.json`
