---
name: reorient
description: "Use when a project undergoes a direction change — reorientation, scope redefine, approach revert, or major pivot. This skill ensures that ALL context files are updated consistently, not just the obvious ones. Invoke this skill proactively whenever you find yourself changing a project's current phase in STATUS.md, redefining milestones in roadmap.md, deprecating experiments, or reverting an approach. Also use when the user says 'pivot', 'redefine scope', 'revert approach', 'change direction', or 'direction has changed'. The reason this skill exists: context files must be consistent because each session starts fresh with no memory. If you update STATUS.md but forget to update mission.md, CORTEX.md index, or existing TASKS entries, the next session will execute based on stale information — potentially wasting hours of GPU time on the wrong configuration."
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
argument-hint: "<project-name>"
---

# Reorient

You are performing a **project reorientation** — a systematic propagation of a direction change across all context files.

This skill exists because of a repeatedly observed failure mode: when a project changes direction, the session that makes the change updates the "core" files (STATUS.md, roadmap.md, new TASKS entries) but misses "peripheral" targets (mission.md, CORTEX.md index, existing task descriptions, experiment deprecation notices, decision records). Fleet workers then faithfully execute stale instructions, producing wasted or wrong work.

Real examples that motivated this skill:
- A task said "test_lights evaluation" but eval config had changed to L1-only → 1.5h GPU wasted
- Project reoriented from symmetric to directed inference, but mission.md/roadmap.md never updated
- CORTEX.md experiment index still described a deprecated range after R1 was redefined
- New tasks created with `[[double-brackets]]` broke the parser for 3 hours

The core principle: **a direction change is not complete until every file a fleet worker might read has been checked for consistency.**

## Target

$ARGUMENTS

If a project name is provided, reorient that project. If empty, ask which project is being reoriented.

## Step 1: Declare the Change

Before touching any files, articulate the change clearly. Write these three items (you'll include them in the final commit and checklist):

1. **What changed**: `<old direction>` → `<new direction>`
2. **Why**: the trigger (failed experiment, user feedback, new evidence)
3. **Scope of impact**: which milestones, experiments, and tasks are affected

If you're already in the middle of making the change (e.g., you just updated STATUS.md), reconstruct this declaration from what you've already done. The declaration doesn't need to be a separate document — it's the mental model that guides the propagation scan.

## Step 2: Update Core Files

These are the files that directly express the change. Update them first:

| File | What to update |
|------|---------------|
| `STATUS.md` | Full register rewrite for the new direction (Current Situation / In Flight / Blockers / Next Step, per rules/status-md.md) |
| `roadmap.md` | Affected milestone definitions and verification conditions |
| `experiments/index.md` | Mark affected experiments as `superseded` or `deprecated` in the index table |

If any of these are already updated (because you did it before invoking this skill), skip to Step 3. The value of this skill is in Step 3, not Step 2.

## Step 3: Propagation Scan

This is the critical step. Scan every `.md` file in the project directory and check consistency with the new direction.

### 3a. Discover all files

```bash
find context/projects/<project>/ -name "*.md" -type f
```

### 3b. Check each file against the new direction

For each file, read it and assess:

| File | What to check |
|------|--------------|
| **mission.md** | Problem definition, success criteria — still accurate? (Needs user confirmation to modify per safety rules) |
| **CORTEX.md** (project-level) | Index descriptions — do they reflect current experiment range, file structure, phase? |
| **idea.md** (if exists) | Framing, hypothesis — still aligned with new direction? |
| **knowledge/** (if exists) | Any knowledge entries (knowledge/K-NNN.md) based on now-deprecated experiment conclusions? |
| **ISSUES.md** | Any issues that are resolved or irrelevant under new direction? |
| **decisions/** (all files) | Any DR that references the old framing or old assumptions? Update Status line if superseded. |
| **TASKS.md** (per-task) | See detailed task check below |
| **Other .md files** | Any project-specific docs (codebase docs, asset plans, etc.) — stale references? |

### 3c. Detailed TASKS.md check

This is where most fleet drift originates. Check **every uncompleted task** individually:

For each `- [ ]` task:
1. **Description accuracy**: Does the task text match the new direction? Watch for:
   - Eval configurations that changed (e.g., "test_lights" vs "L1-only")
   - Method names that changed (e.g., "symmetric" vs "directed")
   - Experiment IDs that were deprecated
   - Checkpoint references that are no longer valid
2. **Dependency validity**: Are `[depends-on: XXXX]` targets still relevant?
3. **Tag formatting**: Verify `[single-brackets]`, not `[[double-brackets]]` or malformed nesting
4. **Blocked-by gates**: Should Phase N tasks have a validation gate (e.g., `[blocked-by: user confirms X]`)?

If a task is stale but you can confidently update it → update the description.
If a task is stale and you're unsure how to update it → add `[blocked-by: context-stale — needs review after reorientation]`.

### 3d. Check OVERVIEW.md

Read `context/OVERVIEW.md` and verify the project's one-line status is still accurate.

## Step 4: Execute Updates

Update all files marked as needing changes in Step 3.

Important constraints:
- **mission.md modifications require user confirmation** (per CORTEX.md safety boundary). If mission.md needs updating, flag it in the checklist and ask the user.
- **Don't create new decision records** — the reorient skill handles propagation, not decision-making. The direction change itself should already be documented by whatever triggered it.
- **Deprecated experiment full-text entries**: If you marked experiments as deprecated in the index (Step 2), also add a deprecation notice to the full-text entry body so that a worker reading only the full text (not the index) sees the deprecation.

## Step 5: Propagation Checklist

Output a complete verification table. This is the deliverable of the reorient skill — it proves every file was checked.

```markdown
## Reorientation Propagation Checklist

**Project**: <project-name>
**Change**: <old direction> → <new direction>
**Trigger**: <why the change happened>
**Date**: YYYY-MM-DD

| # | File | Status | Change Summary |
|---|------|--------|---------------|
| 1 | STATUS.md | updated | Current Situation → X |
| 2 | roadmap.md | updated | M2 redefined: ... |
| 3 | mission.md | no change needed | Problem definition unaffected |
| 4 | CORTEX.md | updated | Experiment index range corrected |
| 5 | TASKS.md (b2b4) | updated | eval scope → L1-only |
| 6 | TASKS.md (ac1d) | blocked | context-stale: needs user review |
| ... | ... | ... | ... |

**Files checked**: N/N
**Tasks checked**: N uncompleted tasks
**Stale tasks blocked**: N
**Needs user confirmation**: mission.md (yes/no)
```

Status values:
- `updated` — Changed in this reorient
- `no change needed` — Checked and consistent
- `blocked` — Marked context-stale, needs human review
- `needs confirmation` — Requires user approval (e.g., mission.md)
- `already current` — Was updated before this skill was invoked

## Step 6: Commit

Commit all changes as a single atomic commit:

```
<project>: reorient — <old direction summary> → <new direction summary>
```

Include the propagation checklist summary in the commit body (how many files checked, how many updated, how many tasks blocked).

## Behavior Guidance

- **Be thorough, not fast.** The whole point of this skill is to catch what you'd normally miss. Reading every file in the project directory takes 2 minutes; missing a stale task costs hours.
- **Check existing tasks individually.** The most common drift is in task descriptions. Don't just scan TASKS.md as a whole — read each uncompleted task line by line.
- **When in doubt, block the task.** Adding `[blocked-by: context-stale]` is cheap and reversible. A fleet worker executing a stale task is expensive and irreversible.
- **This skill is idempotent.** Running it twice should produce no additional changes if the first run was thorough.
- **Don't skip files because they "probably" don't matter.** The retrospective showed that mission.md, idea.md, and project CORTEX.md are the most commonly missed — precisely because they seem peripheral.
