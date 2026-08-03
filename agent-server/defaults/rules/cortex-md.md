---
paths:
  - "context/**/CORTEX.md"
---

# CORTEX.md Index Convention

Directory index + entry map. Auto-injected into agent context by cortex-md-injector (**truncated at 9500 characters**) — the byte count IS the injection budget. It answers "what is here, where to look", not "what the content is": each line exists so an agent knows where to read, not as a substitute for reading.

## Hard Constraints

- **Hard cap: 120 lines AND 8KB** (enforced by guard hook; content past the truncation line never gets injected — pure waste).
- **Each index line <=200 characters**: one sentence of purpose + pointer.
- **One line per atomic directory**: experiments/, knowledge/, patterns/, decisions/ each take a single line in the index, pointing at their auto-generated index.md (or the directory itself). **Never enumerate per-entry summaries** — summaries already live in the atomic files' frontmatter and index.md; copies in the index are pure redundancy.

## Update Mode

- Update synchronously when files are created or deleted (existing meta-conventions requirement).
- An index line's description is one stable sentence; evolution of a file's **content** does not change its index line (content evolution goes into the file itself or STATUS.md).
- When adding a line, check for dead lines (pointing at deleted/archived files).

## Prohibited Content

- Per-entry summaries/conclusions → atomic file frontmatter + auto index.md
- Current state/progress/latest results → `STATUS.md`
- Full decision rationale and verdicts → `decisions/DR-NNNN.md` (index line keeps ID + one sentence)
- Long quotes, data, commands → their own files

## Overflow Handling

When over the cap, first delete duplicates (anything findable elsewhere becomes a pointer), then merge low-value lines. The guard hook rejects over-limit writes; writes that shrink the current file (trimming legacy content) are allowed.
