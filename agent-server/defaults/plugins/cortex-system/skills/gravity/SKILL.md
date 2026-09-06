---
name: gravity
description: "Use when a manual fix or workaround keeps recurring and might need to be formalized into a convention, skill, or code"
allowed-tools: Read, Grep, Glob
metadata:
  argument-hint: "[pattern description or 'scan']"
---

# /gravity <pattern description or "scan">

You are evaluating whether recurring patterns should move downward in the formalization stack — from manual practice into conventions, skills, or code. The `/compound` skill *detects* gravity signals; this skill *evaluates* them.

The argument is either a specific pattern to evaluate (e.g., "agents keep manually computing metric breakdowns") or "scan" to search for gravity candidates across the repo.

## If argument is "scan"

Search for gravity signals across the repo:

1. Read project STATUS.md files and experiment entries (experiments/index.md, experiments/EXP-NNN.md) for recurring patterns:
   - Similar commands or procedures appearing in multiple experiment entries
   - Manual steps described repeatedly
   - Workarounds or hacks mentioned in logs or open questions
   - TODOs that keep reappearing across sessions
2. Check `.claude/skills/` — are any skills encoding judgment that has matured enough to become convention or code?
3. Check project knowledge entries (knowledge/index.md, knowledge/K-NNN.md) — any frequently referenced entries that should be promoted to rules?
4. Check experiment Reflection fields in experiments/EXP-NNN.md (behavior adjustments/process defects) — same adjustment appearing 3+ times?

Produce a candidate list, then evaluate each candidate below.

## For each gravity candidate

### Step 1: Establish recurrence

- **How many times** has this pattern appeared? Cite specific experiment entries, files, or sessions.
- **How consistent** is it? Same pattern each time, or variations?
- **Is it still evolving?** A pattern that changes each time it appears is not yet stable enough to formalize.

A pattern must appear at least 3 times in substantially similar form before formalization is justified. If it has appeared fewer than 3 times, note it as "watch" rather than "act."

### Step 2: Identify current layer and target layer

Where does the pattern currently live?

| Current state | Formalization level |
|---|---|
| Human does it manually each session | Manual |
| Written as a convention/rule in CORTEX.md | Convention |
| Encoded as a skill prompt | Skill |
| Implemented as a script or validator | Code |

Where should it move to?

| Target | When appropriate |
|---|---|
| Manual → Convention | Recurring judgment crystallized into a rule that always applies |
| Manual → Skill | Recurring multi-step procedure that benefits from structured guidance |
| Manual → Code | Recurring procedure that can be fully automated |
| Convention → Code | Rule that can be checked deterministically |
| Skill → Convention | Judgment has crystallized into a universal rule |
| Skill → Code | Judgment can be computed deterministically |
| Knowledge → Rule | Knowledge entry frequently referenced in experiments |

### Step 3: Evaluate migration cost and benefit

**Benefit:**
- How much time/effort does the manual pattern cost per occurrence?
- How likely is the pattern to recur? (weekly? every session? every project?)
- What is the risk of the manual version being done inconsistently or incorrectly?

**Cost:**
- How much effort to formalize? (writing a convention: ~5 min; writing a skill: ~30 min; writing code: hours-days)
- Does formalization risk premature optimization? (encoding a pattern that hasn't stabilized yet)
- Does it add complexity that makes the system harder to understand?

**Decision rule:** Formalize when `(frequency × cost_per_occurrence × inconsistency_risk) > formalization_effort`. When in doubt, wait — premature formalization is worse than repeated manual work.

### Step 4: Design the migration

If the candidate passes the cost-benefit check:

- What exactly gets created? (new convention in CORTEX.md, new skill, new knowledge entry in knowledge/K-NNN.md, new validator script)
- What gets removed or simplified? (gravity should simplify the layer above, not just add to the layer below)
- What is the verification? How do you confirm the formalization actually captures the pattern?

## Output format

```
## Gravity assessment
Date: YYYY-MM-DD

### Candidates evaluated

#### <pattern name>
Recurrence: <N times — cite evidence>
Stability: stable | evolving | premature
Current level: Manual | Convention | Skill | Code
Target level: Manual | Convention | Skill | Code
Frequency: <how often it recurs>
Cost per occurrence: <low | medium | high>
Formalization effort: <low | medium | high>
Verdict: **formalize now** | **watch** | **decline**
Rationale: <1-2 sentences>
Migration plan: <what to create, what to simplify — or "n/a" if watch/decline>

[repeat for each candidate]

### Summary
- Formalize now: <list>
- Watch: <list>
- Decline: <list>
```

Be conservative. The Cortex convention is "grow structure on demand" — do not formalize patterns that are still evolving or that have appeared fewer than 3 times.

## Task Bridge

For candidates with verdict "formalize now":
1. Create a task in the relevant project's TASKS.md for the migration plan
2. Tag with appropriate lifecycle tags (e.g., `[template: ...]` based on the nature of the work)
3. `Done when:` the pattern has been formalized at the target level
4. `Why:` referencing this gravity assessment

For candidates with verdict "watch": no task — noted for future evaluation.
