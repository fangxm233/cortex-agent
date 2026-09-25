---
paths:
  - "context/projects/*/decisions/**"
---

# Decision Records (DR)

Independent documentation of design decisions, with two levels:
- **System-level** (`context/decisions/NNNN-title.md`): Decisions affecting Cortex's overall behavior — memory architecture, workflow design, knowledge management approach, cross-project conventions
- **Project-level** (`context/projects/<project>/decisions/NNNN-title.md`): Project direction decisions — technical route selection, solution design, scope adjustments

**Classification criteria**: Affects cross-project behavior or Cortex system conventions → system-level. Only affects a single project's technical direction → project-level. When in doubt, place at system-level.

## When to Create a DR

All three conditions **must be satisfied**:
1. Multiple feasible options exist (not a bug fix or single option)
2. The choice has lasting impact on architecture or direction (not a temporary tactical decision)
3. Future sessions need to know "why X was chosen over Y"

**When a DR is not needed**: Bug fix (no alternatives), experiment parameter adjustments (temporary), status description (belongs in STATUS.md).

## Schema

```markdown
# DR-NNNN: <Title>

Date: YYYY-MM-DD
Status: accepted | rejected | superseded
Supersedes: DR-NNNN (optional)
Evidence: EXP-NNN, EXP-NNN

## Context
## Options Considered (at least 2 options, required)
## Decision
## Consequences
```

**Reference format**: `DR-NNNN` (analogous to `EXP-NNN` and `K-NNN`). Numbering is independent within each level (system-level and each project starts from 0001).

**Indexing rule**: After adding a new DR, you must add an inline reference link in the corresponding level's AGENTS.md.

## Boundaries with Other Knowledge Types

| Type | What it records | Example |
|------|-----------------|---------|
| DR | Which option was chosen from multiple alternatives and why | "Two-phase generation vs reject-retry" |
| knowledge/K-NNN.md | Project-level accumulated knowledge (technical details, methodology, debugging experience) | "VLM anti-hallucination three techniques", "TRELLIS2 degradation after 7h" |
| EXP | Evidence and conclusions of a specific run | "EXP-019: success rate 23/60" |
