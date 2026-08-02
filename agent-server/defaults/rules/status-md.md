---
paths:
  - "context/projects/*/STATUS.md"
---

# STATUS.md Convention

The project's **present tense**: the minimal state a fresh session needs to continue working correctly. A register, not a journal.
It answers exactly four questions: where are we, what is in flight, what is in the way, what comes next.

## Three Admission Tests (apply before every write)

1. **Deletion test**: would removing this line cause a future session to decide wrongly or waste time? If not → do not write it.
2. **Grows with state, not with time**: file size may only track state complexity, never project age. Entries that only get added and never removed = the file has degraded into a journal.
3. **60-second handoff**: the whole file = what you could tell a new collaborator in 60 seconds. Anything beyond that belongs in its durable home.

## Hard Constraints

- **Update mode: overwrite-rewrite the snapshot**. Every "add a line" must be paired with a check for which existing lines it makes stale — delete those.
- **Length limit: 80 lines AND 6KB, both hard**. Scan before writing: at >=60 lines or >=4KB, warn and trim proactively; over the limit, trim below it before the write is allowed.
- **Each bullet <= 2 lines**. If it doesn't fit, the detail belongs elsewhere — keep one sentence + a pointer.
- **Facts with a durable home appear only as pointers**: task-id / EXP-NNN / K-NNN / DR-NNNN / commit SHA / file path. The only content unique to STATUS is the one-sentence synthesis of the current situation.

## Required Sections (in order)

```markdown
# <project> Status

Updated: YYYY-MM-DD

## Current Situation
<One paragraph: position on the roadmap + core focus + one-sentence situation call>

## In Flight & New Variables
<<=5 items, each <=2 lines + pointer. Only events that changed the situation:
what got unblocked, what new constraint appeared, why the next step changed.
Delete an item the moment it stops affecting decisions — its content already
lives in tasks-archive/git/EXP, nothing to migrate. Write "none" if empty.>

## Blockers & Pending Decisions
<External blockers, decisions awaiting the user, traps a fresh session would hit. Write "none" if empty.>

## Next Step
<The concrete next action, pointing to a TASKS.yaml task-id or a plan file>
```

## Update Triggers

Update on state change, not on task completion: phase advance/pause/pivot, a blocker appearing or clearing, the next step changing, in-flight work landing in a way that affects decisions, session end (per the working-record discipline).

"A task finished" is not by itself a reason to write. Write only when the completion **changed the situation** (unblocked something / introduced a blocker / changed the next step), and write only the one-line situation change.

## Prohibited Content

- Task completion reports (test counts, verification steps, commit lists) → TASKS.yaml completion note / tasks-archive / task artifact
- Experiment data and conclusions → experiments/EXP-NNN.md
- Settled knowledge / methodology → knowledge/K-NNN.md
- Design decision trade-offs → decisions/DR-NNNN.md
- Change history → git log is the changelog; no file may duplicate it
- Superseded old phase descriptions → delete directly (their outputs should already be settled into EXP/K/PAT)

## Overflow Handling

When over the limit, trim in this order:
1. Delete "In Flight & New Variables" items that no longer affect decisions
2. Compress any bullet over 2 lines into one sentence + pointer
3. Still over → the state itself is too complex: consider splitting a sub-project or driving the roadmap to converge, and record that call under "Blockers & Pending Decisions"
