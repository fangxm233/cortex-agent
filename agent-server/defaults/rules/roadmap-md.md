---
paths:
  - "context/projects/*/roadmap.md"
---

# roadmap.md Convention

Project roadmap and milestones. The machine uses this to determine phase progression and completion status.

## Hard Constraints

- **Stable file**: Milestone structure changes should be triggered by a re-orientation or a recorded decision.
- **Each milestone must contain testable verification conditions** (checklist format). A milestone without a checklist is invalid.
- Completed milestones are retained with check marks, not deleted (for reviewing roadmap history).
- Length suggestion: ≤ 250 lines. If exceeded, consider splitting sub-projects or archiving completed phases.

## Required Structure

```markdown
# <project> Roadmap

## Phase 1: <Name>
Status: ✅ Complete / 🔄 In Progress / ⏳ Pending
Goal: <What this phase aims to achieve>

Verification Conditions:
- [x] <Verifiable condition 1>
- [x] <Verifiable condition 2>

Outputs:
- EXP-NNN, K-NNN, ... (pointing to settled atomic files)

## Phase 2: <Name>
...
```

## Verification Condition Writing Guidelines

Each checklist item must be **machine-determinable** or **objectively verifiable by another agent**.

Compliant:
- `[ ] End-to-end demo passes on staging (verified by EXP-NNN)`
- `[ ] PR #123 merged`
- `[ ] knowledge/K-012 created and referenced ≥ 1 time`

Non-compliant:
- `[ ] System performs well` (not determinable)
- `[ ] Verification completed` (missing completion conditions)
- `[ ] Improve performance` (no target value)

## Prohibited Content

- Current status → belongs in `STATUS.md`
- Task list → belongs in `TASKS.yaml` (roadmap is milestone-level, not task-level)
- Experiment details → belongs in `experiments/`
