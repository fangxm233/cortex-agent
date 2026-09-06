---
name: refresh-skills
description: "Use when skills may be out of date with CORTEX.md conventions, after significant system changes, or for periodic skill health audits"
allowed-tools: Read, Grep, Glob, Edit, Write
metadata:
  argument-hint: "[skill name, 'all', or 'report']"
---

# /refresh-skills <target>

Skills encode operational guidance, but the system evolves faster than skills get updated. This skill audits skills against current conventions and codebase, identifies drift, and applies fixes.

The argument determines scope:

| Argument | Behavior |
|---|---|
| `all` | Audit every skill, update all that need it |
| `report` | Audit every skill, report drift but don't edit |
| `<skill-name>` | Audit and update one specific skill |
| (no argument) | Same as `all` |

## Step 1: Inventory

Read every `SKILL.md` under `.claude/skills/*/`. For each, extract:

- **Name** and description
- **Source references** — which files, conventions, patterns does this skill reference?
- **Last edit date** — from git log

## Step 2: Cross-reference against current state

For each skill's references, read the actual current files. Check for:

### Description compliance

Skill descriptions are injected into Claude's system prompt for skill selection. They must state ONLY triggering conditions — never summarize the skill's workflow or process.

**Rule:** Descriptions answer "When should I invoke this?" not "What does this skill do?"

**Why:** Descriptions summarizing workflow cause the agent to shortcut — following the description instead of reading the full skill body.

**Checklist for each description:**
1. Does it describe a situation, symptom, or trigger? (good)
2. Does it summarize the skill's process or output? (bad — rewrite)
3. Does it use verbs that describe the skill's actions (e.g., "analyze", "generate", "validate")? (bad — replace with triggering conditions)

**Format:**
```yaml
# BAD: Summarizes workflow
description: "Process human feedback — investigate root cause, log learnings, and implement improvements"

# GOOD: Triggering condition only
description: "Use when the PI or a human provides feedback, corrections, or direction on agent work"
```

### Content drift (skill says X, conventions say Y)

- **Convention references**: Does the skill reference CORTEX.md rules that still exist and still say the same thing?
- **File paths**: Do referenced files still exist at those paths?
- **Behavioral descriptions**: Does the skill describe flows that match current conventions?
- **Schema references**: Does the skill reference schemas (experiment file format, DR format, task format) that are current?
- **Cross-skill consistency**: If the same guidance appears in multiple skills, is it consistent?

### Structural gaps (convention exists, no skill covers it)

- Are there CORTEX.md sections or K-entries that no skill references?
- Are there recent decisions/ records that should be reflected in skill guidance?

### Staleness signals

- `git log` for referenced files vs skill file — if conventions changed but skill hasn't, drift candidate
- Skills referencing deprecated features or removed conventions

### Provenance review (decay mechanism)

Skills accumulate rules from incidents (postmortems, feedback, K-entries) but lack a decay path. For each rule in the skill:

1. **Trace provenance.** Look for references to decisions, K-entries, experiments, or inline comments explaining why the rule exists. If no provenance → flag as `[untraced]`.

2. **Check resolution status.** If the rule was motivated by a specific failure mode:
   - Is the failure now prevented by other means (code check, convention in CORTEX.md)? → flag as `[redundant]`, candidate for removal
   - Has the failure recurred in the last 90 days? → if no recurrence → flag as `[dormant-90d]`

3. **Classification:**
   - **Remove** — failure mode is now handled elsewhere. Safe to remove from skill.
   - **Compress** — rule is valid but verbose; the same guidance exists in CORTEX.md. Replace with cross-reference.
   - **Keep** — rule addresses a failure mode still possible and not handled elsewhere.
   - **Investigate** — provenance unclear; cannot determine if still needed.

## Step 3: Report

For each skill, produce a drift assessment:

```
### <skill-name>
Status: current | drifted | stale
References: <list of source files this skill depends on>
Last skill edit: <date>
Last source edit: <date for referenced files>

Drift items:
- [ ] <specific item needing update — quote stale text and current truth>

Missing coverage:
- [ ] <convention or behavior this skill should mention but doesn't>

Provenance:
- [remove] <rule> — now handled by <mechanism>
- [compress] <rule> — duplicate of <CORTEX.md section>
- [investigate] <rule> — no provenance found
```

If target is `report`, stop here.

## Step 4: Update

For each drifted skill, apply fixes using Edit:

1. **Update stale references** — correct file paths, convention references, schema fields
2. **Add missing coverage** — document new conventions or behaviors
3. **Remove dead references** — delete guidance about features that no longer exist
4. **Preserve voice** — match existing tone and structure; don't rewrite what isn't broken
5. **Propagate shared content** — if same guidance appears in multiple skills, ensure consistency

After each edit, verify the skill still reads coherently.

## Step 5: Summarize

```
## Skill refresh summary
Date: YYYY-MM-DD

Skills audited: <N>
Skills updated: <N>
Skills current (no changes needed): <N>

### Changes made
- <skill>: <1-line summary of what changed>

### Remaining issues
- <anything that needs human decision or is beyond this skill's scope>
```

## What this skill does NOT do

- **Create new skills** — that's `/skill-creator` or `/evolve`
- **Delete skills** — flag obsolete skills in the report, but don't remove them
- **Change skill scope or purpose** — flag for human review if a skill's mission has shifted
- **Edit CORTEX.md or decisions/** — flag inconsistencies but only edit SKILL.md files
