---
paths:
  - "context/**"
---

# Context Meta-Rules

Cross-file conventions. See the dedicated rule for each file type in the same directory (status-md.md / issues-md.md / mission-md.md / roadmap-md.md / overview-md.md / agents-md.md / experiment-format.md / decision-records.md).

## General Rules

- **Persist context updates after each logical unit** (experiment configuration, analysis report, status update). Save the files directly; do not accumulate updates until the end of the session.
- **Value traceability**: Every value appearing in STATUS / EXP / K / reports must be traceable — specify the script + data file that produced it, or write inline arithmetic citing the data. Numbers without sources are invalid.
- **Update index after creating new files**: After creating a new file in any directory, update that directory's AGENTS.md index (see agents-md.md).
- **Decision traceability**: Each DR-NNNN within a project adds an inline reference in the project's AGENTS.md; system-level DRs are referenced in `context/AGENTS.md`.

## Index Files

`experiments/index.md`, `knowledge/index.md`, `patterns/index.md` are auto-generated from frontmatter (git-ignored, rebuilt by the server whenever an atomic file changes). **Do not manually edit**. Rebuild by hand:

```bash
cortex memory regen                      # all projects
cortex memory regen --project <project>
```

## Hook Auto-Tracking

PostToolUse hook automatically records Read/Grep access to atomic files (EXP/K/PAT) in `_meta/access-log.jsonl`; the index rebuild counts refs and last-ref from it and shows them only in index.md — do not add refs fields to atomic files.

## File Type Quick Reference

| File | Dedicated rule | Update mode |
|------|----------------|-------------|
| `STATUS.md` | status-md.md | Overwrite snapshot (state register), hard limit 80 lines AND 6KB, each bullet <=2 lines |
| `ISSUES.md` | issues-md.md | Append, resolved entries deleted directly, hard limit 80 lines AND 6KB, each entry <=4 lines |
| `AGENTS.md` (directory index) | agents-md.md | Pointer-style index, hard limit 120 lines AND 8KB, one line per atomic directory |
| `mission.md` | mission-md.md | Modify after user confirmation |
| `roadmap.md` | roadmap-md.md | Stable, milestones must contain testable checklist |
| `OVERVIEW.md` | overview-md.md | Synchronous update, hard limit 60 lines |
| `experiments/EXP-NNN.md` | experiment-format.md | Atomic file + frontmatter |
| `knowledge/K-NNN.md` | experiment-format.md | Atomic file + evidence field |
| `patterns/PAT-NNN.md` | experiment-format.md | Atomic file + source-experiments |
| `decisions/DR-NNNN.md` | decision-records.md | Append, keep old file when superseded |
| `_meta/access-log.jsonl` | — | Auto-written by hook |
| `*/index.md` | — | Auto-generated (`cortex memory regen`) |
