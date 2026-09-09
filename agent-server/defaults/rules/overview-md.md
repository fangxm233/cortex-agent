---
paths:
  - "context/OVERVIEW.md"
---

# OVERVIEW.md Convention

Cross-project global view: one-line status per project + current focus. Primary input whenever a session needs to re-establish where everything stands.

## Hard Constraints

- **Synchronous update**: Immediately synchronize after project status changes (phase advancement, pause, archiving).
- **Length limit: 60 lines**. Exceeding means too many projects or descriptions are too long — compress one-line descriptions, or archive completed projects to the appendix.
- **One line per project**: Project-level details belong in `projects/<name>/STATUS.md`, OVERVIEW only contains index-level summaries.

## Required Structure

```markdown
# Overview

| Project | Status | Priority | Last Activity |
|---------|--------|----------|---------------|
| <name> | **<phase title>** — <one-line current status> | High/Medium/Low | YYYY-MM-DD |
...

## Current Focus
<One paragraph + numbered list, listing current priority projects and reasons>
```

## One-line Status Writing Guide

- Must include: Current phase title (**bold**)
- Must include: One-line current status (blocked on what / doing what / next step)
- Must not include: Experiment details, numerical results (→ EXP-NNN), decision reasoning (→ DR)

## Prohibited Content

- Project task list → belongs in `projects/<name>/TASKS.yaml`
- Project current phase details → belongs in `projects/<name>/STATUS.md`
- Experiment/knowledge entries → belongs in `projects/<name>/experiments|knowledge/`

