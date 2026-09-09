# context/ Index

Root directory for project context. All project state, experiment records, knowledge entries, patterns, decisions, and scan reports live here.

## Directory Structure

| Path | Purpose | Description |
|------|---------|-------------|
| `OVERVIEW.md` | Global overview | One-line status per project + Last Scan date |
| `decisions/` | System-level decision records | Design decisions affecting Cortex overall behavior, named as `NNNN-title.md` |
| `projects/` | Project context | One subdirectory per active project |
| `scans/` | Knowledge scan reports | Named by date `YYYY-MM-DD.md`, each scan outputs here |
| `ideas/` | Idea incubation library | Directions in Incubating status, promoted to project when mature |
| `retrospectives/` | Experience distillation reports | Distilled from historical logs for cross-session knowledge, named as `YYYY-MM-DD-<topic>.md` |
| `user/` | User profile | Cross-project user personal preferences (identity, communication style, output format, etc.), maintained by `/user-learn`, hard limit 3KB |
| `PENDING_APPROVALS.md` | Approval queue | Operations requiring user confirmation, managed by /approval |

## Lookup Rules

- **Find user preferences** -> `user/USER.md`
- **Find system-level decisions** -> `decisions/` (browse with ls, search with grep)
- **Find project-level decisions** -> `projects/<name>/decisions/`
- **Find project task queue** -> `projects/<name>/TASKS.md` (structured task list)
- **Find experience distillation** -> `retrospectives/YYYY-MM-DD-<topic>.md`
- **Find scan report** -> `scans/YYYY-MM-DD.md`
- **Find project current state** -> `projects/<name>/STATUS.md`
- **Find project execution friction/efficiency issues** -> `projects/<name>/ISSUES.md`
- **Find experiment records** -> `projects/<name>/experiments/index.md` (index table), details via Read specific `EXP-NNN.md`
- **Find knowledge entries** -> `projects/<name>/knowledge/index.md` (index table), details via Read specific `K-NNN.md`
- **Find cross-experiment patterns** -> `projects/<name>/patterns/index.md`
- **Find completed task history** -> `projects/<name>/tasks-archive.md` (auto-archive >3 days after completion)
- **Find project goals** -> `projects/<name>/mission.md`
- **Find roadmap** -> `projects/<name>/roadmap.md`
- **Find incubating direction ideas** -> `ideas/<name>.md`
- **Find global overview** -> `OVERVIEW.md`
- **Find pending approval operations** -> `PENDING_APPROVALS.md`

## Key System Decisions

<!-- Add inline reference here after adding a new decision -->
