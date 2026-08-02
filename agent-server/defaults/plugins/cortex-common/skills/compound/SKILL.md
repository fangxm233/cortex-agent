---
name: compound
description: "Use at the end of a work session, or when accumulated findings need to be embedded into conventions, skills, or patterns"
argument-hint: "[optional: 'fast', 'full', 'deep', or no argument for auto-detect]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
---

# /compound [tier]

Compound engineering phase — turns session work into accumulated system advantage by embedding learnings into conventions, skills, and patterns. Invoked at session close or standalone.

## Tier selection

$ARGUMENTS

If an explicit tier is provided ("fast", "full", "deep"), use it. Otherwise, auto-detect:

1. Read `agent-server/orient-state.json` → `lastFullCompoundAt`
2. Read CORTEX.md → `Last consolidation` date, count experiments since then across all projects
3. Decision:
   - `lastFullCompoundAt` < 3h ago AND experiments since consolidation < 5 → **FAST**
   - Experiments since consolidation >= 5 → **DEEP** (consolidation is due)
   - Otherwise → **FULL**

| Tier | Steps | Duration | When |
|------|-------|----------|------|
| Fast | 1, 2, 10 | ~1-2 turns | Full ran <3h ago, no consolidation trigger |
| Full | 1-3c, 4-6c, 10 | ~2-5 min | Standard end-of-session |
| Deep | 1-10 | ~10-15 min | 5+ experiments since consolidation, or standalone |

**Pre-compound commit:** Check `git status`. If there are uncommitted session changes, commit them first.

## Principles

1. **Small, correct updates over ambitious rewrites.** Fix a typo, add a gotcha, note a pattern. Don't redesign CORTEX.md in a compound step.
2. **Evidence over intuition.** Only embed learnings grounded in concrete session experience. "I noticed X went wrong" → update. "I think Y might be better" → task for evaluation.
3. **Classify before acting.** Every compound finding falls into one of the output categories in Step 10. Classify first, then act.
4. **Respect approval gates.** Governance changes (budget rules, approval workflow, core CORTEX.md structure) → PENDING_APPROVALS.md. Convention clarifications, gotcha additions, project knowledge/index.md updates → apply directly.

---

## Fast compound

### Step 1: Review session work

Run `git diff --stat HEAD~3..HEAD` and `git log --oneline -5`. Identify:
- What task was completed (or partially completed)?
- What files were created or modified?
- Were there surprises or difficulties?

### Step 2: Session learnings (4 questions)

Ask about this session's work:

1. **Did I discover a non-obvious fact?** (API quirk, hidden constraint, undocumented behavior)
   → If yes: update to project knowledge/index.md or relevant project file.

2. **Did I encounter a failure mode future sessions should avoid?** (silent error, misleading config, common mistake)
   → If yes: add gotcha to relevant skill or project knowledge/index.md.

3. **Did I develop a technique that worked well?** (debugging strategy, analysis pattern, verification method)
   → If yes and generalizes: note as gravity candidate or add to skill.

4. **Did I work around a convention that didn't fit?** (CORTEX.md rule unhelpful, schema too rigid, skill misleading)
   → If yes: update the convention/skill, or note friction.

5. **Did I make or confirm a significant design choice?** (chose approach X over Y, rejected a direction, confirmed an architecture)
   → If yes and meets DR criteria (multiple options, lasting impact, rationale matters): create a Decision Record in the appropriate `decisions/` directory (system-level for cross-project impact, project-level otherwise), then add an inline reference in the corresponding CORTEX.md.

### Step 10 (fast): Act on findings

For each finding from Steps 1-2, classify and act per the classification table below. Also do quick task discovery: if an experiment/analysis was completed, check experiments/index.md Findings for implied tasks (failed criteria, insufficient sample, unexplained results, multi-phase gaps).

**Output (fast):** `Compound (fast): N actions — <summary>.` or `Compound (fast): no actions.`

---

## Full compound

Steps 1-2 are the same as fast compound above. Continue with:

### Step 3: Scan unactioned recommendations

First, run the recommendation extractor for a structured scan:

```bash
npx tsx agent-server/src/recommendation-extractor.ts --days 7 --json
```

This tool extracts reflection fields, implied tasks from findings, and recommendation sections from skill outputs (diagnose/postmortem/synthesize), deduplicates against existing TASKS.md, and outputs structured candidates.

Use the tool output as a starting point, then apply judgment:

**Part A: Reflection field scan**
- Review the `reflection_fields` section from tool output.
- For each `behavior adjustments`: Has the adjusted behavior been applied in subsequent experiments? If not and it's actionable → create task or apply directly.
- For each `process defects`: Has a corresponding improvement been made or task created? If not → create task.
- Skip entries that describe one-time situational adjustments already superseded by later experiments.

**Part B: Implied tasks and recommendations**
- Review the `candidates` section from tool output.
- For candidates with `is_duplicate: false`: verify they are genuinely actionable, then create task in TASKS.md.
- For candidates with `is_duplicate: true`: skip (already covered).
- The tool detects these implied task patterns from experiment findings:

| Pattern | Signal phrases | Implied task |
|---------|----------------|--------------|
| Failed criterion | "FAIL", "below threshold", "not achieved" | Refined experiment |
| Insufficient sample | "N too small", "cannot draw conclusions" | Larger replication |
| Confound | "confound", "cannot separate" | Controlled follow-up |
| Unexplained result | "unexpected", "mechanism unclear" | Diagnosis |
| Multi-phase plan | "Phase N" in body | Check phase-tasks exist |

**Anti-loop check**: For recommendations about analyzing running experiments, split into preliminary analysis task (satisfiable mid-experiment) and final analysis task (blocked-by experiment completion). Do not create a single "analyze results" task for an experiment that isn't done — it will be selected repeatedly and produce incomplete conclusions each time.

### Step 3c: Correction propagation check

Check whether the current session made corrections but lacked Downstream Impact analysis.

**Detection method**:
1. Use `git diff` to check if the experiments/index.md index status column has newly added `superseded` or `refined` entries
2. Check if a CORRECTION paragraph has been added
3. Check if the project knowledge/index.md has substantive modifications

**For each detected correction**:
- Check whether the correction record includes a `#### Downstream Impact` paragraph
- If missing: run grep to search for consumers, build an Impact table, create tasks for `needs-update` items
- If all corrections already include Impact analysis: skip

**Skip condition**: No corrections in this session (no supersede/refine, no CORRECTION, no knowledge/index.md modification)

### Step 4: Surface open investigations

Scan active project `experiments/index.md` for unresolved questions:

| Pattern | Signal phrases | Question form |
|---------|----------------|---------------|
| Unexplained result | "unexpected", "mechanism unclear" | "Why does X despite Y?" |
| Untestable hypothesis | "cannot be tested", "future work" | "Under what conditions does H hold?" |
| Methodology confound | "asymmetric setup", "confound" | "How to disentangle X from Y?" |

Also check STATUS.md's Next Step / Blockers & Pending Decisions sections for unresolved items that imply investigation needs. Generate follow-up tasks in TASKS.yaml if none exist for identified questions.

**Part B: Parameter-tuning pattern detection**

Scan this session's `git diff` for "threshold adjustments" — changes where a numeric value was changed from X to Y (timeouts, token limits, retry counts, batch sizes, buffer sizes, etc.).

For each such change, apply five tests:

1. **Understanding**: Do I know the mechanism that required this adjustment?
2. **Generalization**: Is this a problem anyone with a similar system would face?
3. **Solution existence**: Is there a known structural solution, or am I just bumping a number?
4. **Recurrence**: Has this same parameter (or a related one) been adjusted before?
5. **Trade-off nature**: Is the underlying pressure resource-solvable or fundamental?

If ≥2 tests point toward "structural problem" for any adjustment → create a structural review task with provenance citing this session's diff.

**Signal to watch for**: The same parameter adjusted 2+ times, or two different parameters adjusted for the same underlying reason — these are strong indicators of a structural problem hiding behind incremental fixes.

### Step 5: Detect gravity candidates

Check whether this session reveals a pattern that has recurred 3+ times:
- Did you do something manually that a script or validator could do?
- Did you apply judgment that has become routine enough for a convention?
- Did you follow a multi-step procedure that could be simplified into a skill?

Cross-reference with project knowledge/index.md entries: if a knowledge entry has been referenced as decision basis in 3+ experiments, flag it as a knowledge→rule promotion candidate for Step 10.

### Step 6: Convention lifecycle check

#### 6a: Project knowledge/index.md lifecycle

Scan each active project's knowledge/index.md:

**(i) Staleness check**
Knowledge entries with verification date > 60 days → flag as potentially stale. Consider: does the problem still exist? Should evidence be refreshed?

**(ii) Contradiction check**
Compare recent experiment conclusions against knowledge/index.md claims. If a recent experiment's findings contradict a knowledge entry → flag for revision.

**(iii) Anti-templating check**
Read the last 3 experiment Reflection blocks. If `process defects` or `behavior adjustments` have been "none" for 3+ consecutive experiments → force at least one specific observation next time (per CORTEX.md anti-templating rule).

#### 6b: Decision staleness

Scan `context/decisions/` and project-level `decisions/` directories:
- Decisions with Status `accepted` older than 90 days where the context has materially changed → flag for review
- Decisions referenced by K-entries that have been superseded or modified → check if the decision's rationale still holds

#### 6c: Skill drift signal

If during this session you worked around a skill instruction or found a skill misleading:
- Note the skill name and the specific instruction that didn't fit
- Flag for `/refresh-skills` evaluation
- Do not edit the skill inline during compound — skill edits need full context

### Step 10 (full): Act

For each compound finding from Steps 1-6, classify and act:

| Category | Criterion | Action |
|----------|-----------|--------|
| Direct update | Small, verifiable, self-contained | Apply now (CORTEX.md, skill, project file) |
| New task | Larger change, needs design | Add to TASKS.md with provenance |
| Knowledge candidate | Recurring pattern with evidence | Add to project knowledge/index.md |
| Knowledge→Rule promotion | Knowledge entry referenced in 3+ experiments | Queue to PENDING_APPROVALS.md |
| Decision record | Significant design choice with alternatives | Create DR in decisions/ + add CORTEX.md inline reference |
| Approval needed | Governance change | Write to PENDING_APPROVALS.md |

**Direct update rules:**
- Additions preferred over modifications (gotchas safer than rewrites)
- Self-contained (future agent understands without this session's context)
- Propagate changes to all locations in same turn
- **Growth accounting**: When adding 10+ lines to any artifact, identify lines to compress or remove
- **Gate**: If target skill is >400 lines, must simplify before adding new content. A 300-line skill gets a task; a 400-line skill blocks the addition until simplified. This prevents indefinite deferral of complexity management.

**Post-execution state update:**
Read `agent-server/orient-state.json`, set `lastFullCompoundAt` to current timestamp (milliseconds), write back. Preserve all other fields.

**Output (full):**
```
Compound (full) — [date]

Session: [1-2 lines what changed]
Learnings: [knowledge candidates or "none"]
Recommendations actioned: [count or "none"]
Corrections propagated: [count or "none" or "no corrections"]
Open investigations: [count or "none"]
Gravity candidates: [count or "none"]
Convention lifecycle: [flags or "none"]
Tasks discovered: [count or "none"]
```

If no compound actions: `Compound (full): no actions this session.`

---

## Deep compound

Steps 1-6d and 10 are the same as full compound. Continue with:

### Step 7: Consolidation

**Trigger**: 5+ new experiment entries (across all projects) since the last deep compound.

Read each project's experiments/index.md (entries since last deep compound). Perform:

**(a) Pattern scanning**
Look for recurring patterns across experiments. If a pattern appears in 2+ experiments and isn't already in the relevant project's knowledge/index.md → add new entry to project knowledge/index.md.
If a pattern confirms existing knowledge → update evidence and verification date.
Cross-project patterns → add to system-level knowledge under `context/decisions/` or a project-spanning knowledge note.

Also scan **Reflection.behavior adjustments** fields: if the same behavioral adjustment appears in 2+ experiments → add to knowledge/index.md (high confidence, verified process improvement).

**(b) Gap detection**
1. **Process defect clustering**: Same type of process defect in 2+ experiments → log as capability gap
2. **Goal achievement degradation**: 3+ experiments with "partially achieved" and similar root causes → log as systematic blocker
3. **Repeated blocking**: Same step/action blocked in 3+ cycles → log as process/system gap

Classify gaps → Skill gap (propose improvement) | Process gap (propose knowledge/index.md entry or rule) | Knowledge gap (queue an investigation task) | System gap (propose architecture fix).

**(c) Knowledge→Rule promotion evaluation**
Criteria: Entry validated recently + content is process/methodology rule + referenced in 3+ experiments + not redundant with existing CORTEX.md rules.
Candidates → queue to PENDING_APPROVALS.md.

**(d) Effectiveness tracking**
1. Knowledge reference scan: check if new experiments reference knowledge/index.md entries as decision basis
2. Gap→action closure: check if gaps from previous consolidations had recommended actions that were executed successfully
3. Behavioral adjustment follow-through: check if behavior adjustment items from earlier experiments were applied in later ones

### Step 7b: Domain knowledge synthesis check (deep mode only)

Check whether any active project has accumulated enough experiment records to warrant domain knowledge synthesis.

1. For each active project, count completed experiments in experiments/index.md
2. Check whether the project has a knowledge/index.md (or equivalent consolidated knowledge file)
3. If a project has **10+ completed experiments** AND **no knowledge/index.md** (or knowledge/index.md hasn't been updated while 5+ new experiments completed since its last update):
   - Flag as a domain synthesis candidate
   - Create a task: `- [ ] Run domain knowledge synthesis for <project>`
4. If a project already has knowledge/index.md and <5 new experiments since last update, skip it

**Rationale:** Domain knowledge accumulates across experiments but doesn't naturally consolidate. After 10+ experiments, searching individual records becomes impractical. Periodic synthesis makes accumulated knowledge accessible without reading every source.

### Step 8: Artifact complexity monitoring

Check line counts of high-frequency artifacts:

| Artifact | Threshold | Action |
|----------|-----------|--------|
| Project knowledge/index.md entries | >30 per project | Flag for compression or split |
| `.claude/skills/*/SKILL.md` | >200 flag, >300 task, >400 gate | Tiered response |
| `context/projects/*/TASKS.md` | >150 | Create archival task |

For each exceeding threshold: check TASKS.md for existing task. Create one if missing.

### Step 10 (deep): Act

Same as full compound Step 10, plus:
- Record consolidation actions (or "no consolidation needed")
- Record domain synthesis candidates (or "none needed")
- Record complexity monitoring results
- Log compression actions if any

**Post-execution state update:**
Read `agent-server/orient-state.json`, set both `lastFullCompoundAt` and `lastDeepCompoundAt` to current timestamp. Write back preserving all fields.

**Output (deep):**
```
Compound (deep) — [date]

Session: [1-2 lines what changed]
Learnings: [knowledge candidates or "none"]
Recommendations actioned: [count or "none"]
Corrections propagated: [count or "none" or "no corrections"]
Open investigations: [count or "none"]
Gravity candidates: [count or "none"]
Convention lifecycle: [flags or "none"]
Consolidation: [patterns found / gaps detected / promotions / effectiveness verified]
Domain synthesis: [projects flagged or "none needed"]
Complexity: [artifacts flagged or "all within limits"]
Tasks discovered: [count or "none"]
```

---

## Relationship to other skills

- **/orient**: Session-start awareness. Compound is session-end embedding. Orient reads what compound wrote — feedback cycle.
- **/deep-retrospective**: Mines historical JSONL logs across days/weeks. Compound operates on single-session learnings.
- **/evolve**: Discovers skill improvements. Compound may generate evolution candidates.
- **/compound-simple**: Lightweight version for quick post-task reflection.

## Anti-patterns

- **Compound theater**: Trivial updates to show activity. If nothing learned, log "no compound actions".
- **Scope creep**: Executing new work. Compound creates tasks and embeds learnings — it does not do the work.
- **Ungrounded proposals**: Convention changes from single data point. Need 3x recurrence for knowledge entries.
- **Skipping**: Most common failure. Even "routine work" may have friction worth documenting.

## Commit

If standalone: commit changes with descriptive message. If another orchestrated workflow already owns the commit step, defer to that workflow.
