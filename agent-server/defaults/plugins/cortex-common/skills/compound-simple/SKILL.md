---
name: compound-simple
description: "Use when completing a task and need lightweight post-task reflection"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
---

# compound-simple

Simplified compound skill for lightweight post-task reflection. Embed session learnings in <3 turns.

## When to use

At the end of a task, after completing work but before final output. Also usable when only a quick reflection is needed.

## Procedure

Execute these steps in order:

### Step 1: Review what changed

Identify this session's own commits (not other workers' commits that may have landed in parallel):

1. Run `git log --oneline -20` to see recent commits
2. Identify which commits belong to **this task/session** by matching commit messages to the work you just did (project name, task ID, topic). Ignore commits from other concurrent workers.
3. Run `git diff --stat <parent-of-earliest-own-commit>..HEAD` using only your own commit range. If you made no commits, check `git diff --stat` for uncommitted changes instead.

Answer:
- What files changed (in your own commits only)?
- What was accomplished?
- Was the task's Done-when condition fully met?

### Step 2: Check for learnings (5 questions)

Answer each question. If yes, note what to update:

1. **Something fail unexpectedly?** (silent error, missing dependency, wrong assumption)
   → Note the failure and workaround in task completion note

2. **Something succeed unexpectedly?** (easier than expected, found shortcut)
   → Note the technique for potential reuse

3. **Workaround worth noting?** (non-obvious trick, configuration quirk)
   → Add to project STATUS.md or task note

4. **Task description miss something?** (prerequisite not listed, scope underestimated)
   → Note for future task writing improvement

5. **Anything reduce work efficiency?** (misleading requirements, confusing docs, awkward tool behavior, wrong parameters, tiny annoyances, or other friction)
   → Write it to the relevant project's `ISSUES.md`: what happened, when you hit it, and how you investigated it. Record even small friction if it slowed you down at all — minor annoyances are still worth capturing because a later model can remove the root cause.

### Step 3: Check for implied tasks

If you completed an experiment/analysis, scan results for:
- "FAIL" or "below threshold" → task: refined experiment
- "N too small" → task: larger replication
- "unexpected", "mechanism unclear" → task: diagnosis
- Multi-phase plan → check phase tasks exist
- New bugs discovered → task: bug fix
- Documentation outdated → task: doc update

### Step 4: Act on findings

For task creation, use the Write tool to stage a JSON object at a per-session unique path and run `cortex-task add --task-file <unique-path>`; never use a shared staging filename or place task text, why, or done-when in shell arguments.

For each compound opportunity:

| Type | Action |
|------|--------|
| Small update (1-3 lines) | Apply directly to file (STATUS.md, task note, ISSUES.md) |
| Larger change | Create task in TASKS.md with provenance |
| Process improvement | Note in task completion output for orchestrator |

### Step 5: Report actions

Output in this format:

```
Compound: N actions
- <action 1>
- <action 2>
...
```

If no actions: `Compound: no actions this session.`

## What NOT to do

- Do NOT run full `/compound` — that's for the orchestrator
- Do NOT manage K-entries in CORTEX.md — orchestrator concern
- Do NOT run consolidation or convention lifecycle checks
- Do NOT start new work — compound embeds learnings only
- Do NOT add >10 lines to any file without identifying lines to compress
- Do NOT make governance changes — note them for the orchestrator

## Key files to update

- Project `STATUS.md` — if work changed project state
- Project `TASKS.md` — implied follow-up tasks
- Project `ISSUES.md` — workflow friction that reduced efficiency
- Task completion note — learnings and findings for callback
