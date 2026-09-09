---
paths:
  - "context/projects/*/experiments/**"
  - "context/projects/*/knowledge/**"
---

# Correction Propagation

When correcting reported data (experiment superseded/refined, knowledge entry modified, values corrected), the correction must include **Downstream Impact** analysis:

1. **Identify consumers**: `grep -r "EXP-ID" context/` or `grep -r "incorrect value" context/` to search all references
2. **Classify**: `corrected` (already fixed in the same commit) | `needs-update` (create follow-up task) | `no-impact` (referenced the source but unaffected)
3. **Create tasks**: For `needs-update` items, create tasks in the relevant TASKS.md, add `Why:` field referencing the source

**Applicable scenarios**: Experiment marked superseded/refined, knowledge entry modified, CORRECTION paragraph correcting values, any commit modifying reported Findings

## Template

Append to the end of the correction record:

```
#### Downstream Impact
Corrected content: <What was wrong>
Search command: `grep -r "EXP-035" context/`
| File | Status | Incorrect Reference | Corrected Value |
|------|--------|--------------------|-----------------|
| STATUS.md | corrected | "EXP-035 conclusion..." | Updated |
| knowledge/K-005.md | needs-update | "data scaling most effective" | Needs modality distinction |
```

Search + classification takes about 5 minutes. Corrections without Downstream Impact are still worth a one-line note, so a later reader can see the check was done.
