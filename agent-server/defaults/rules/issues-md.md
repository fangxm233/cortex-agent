---
paths:
  - "context/projects/*/ISSUES.md"
---

# ISSUES.md Convention

Records execution friction affecting work efficiency: misleading requirements, confusing documentation, tools that are hard to use, incorrect parameters, process deadlocks, etc. For centralized fixing in subsequent sessions.

## Hard Constraints

- **Length limit: 80 lines AND 6KB** (enforced by guard hook; the dual limit prevents gaming the line cap with mega-lines). Exceeding means unresolved issues are accumulating, triggering cleanup.
- **Each entry <=4 lines**. Investigation detail not fitting is a signal to pointer-ize, not to lengthen the line.
- **Append mode**: New issues are appended to the end.
- **Resolved entries are deleted directly**: No archiving, no history retained. Delete the corresponding entry from the file immediately after fixing.

## Entry Format

```markdown
- **<One-line title>** (<YYYY-MM-DD>): <symptom and impact, 1 line>
  - <root cause guess or confirmation, 1 line; investigation detail → pointer (K-NNN / task artifact / EXP-NNN / file:line)>
```

## Prohibited Content

- Fixed issues (resolved must be deleted, no changelog left behind)
- Investigation journals, reproduction logs, multi-block code → reusable findings go to `knowledge/K-NNN`, task-specific detail goes to that task's artifact; the entry keeps only a pointer
- Experiment failure conclusions → belongs in `experiments/EXP-NNN.md`
- Design decision trade-offs → belongs in `decisions/DR-NNNN.md`
- Project-level blockers → belongs in `STATUS.md` "Blockers & Pending Decisions" section (ISSUES.md records process friction, not phase blockers)

## Overflow Handling

If over the limit before writing:
1. Check for entries that were silently fixed but not deleted → delete them
2. Compress oversized entries back to <=4 lines, pointer-izing investigation detail
3. Merge similar friction into one entry
4. Still exceeded → leave a pointer in STATUS.md "Blockers & Pending Decisions", clear and restart ISSUES.md entirely
