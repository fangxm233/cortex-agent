---
name: execute-review-rubric
description: "Use when reviewing or auditing a Doc Writer or Executor deliverable before clearing it. Trigger whenever Doc Reviewer is about to issue a verdict on a document change (status update, digest, decision record, report, knowledge entry), or Executor Reviewer is about to issue a verdict on an executed task (code changes, file edits, config updates, script runs). Covers the per-dimension rubric, the specific-not-generic standard, Blocker vs Nice-to-have, the review procedure, and the drift patterns for both artifact types."
allowed-tools: Read, Grep, Glob, Bash
---

# /execute-review-rubric — Document & Execution Review Rubric

Apply this rubric when auditing a Doc Writer or Executor deliverable. Pick the mode that matches the artifact under review; both modes share the specific-not-generic standard, the Blocker/Nice-to-have definitions, and the "output quality over effort" stance. Work through every dimension that applies; every Blocker must appear in the review artifact.

**Refuse to clear** work that overclaims, omits sources, is incomplete, incorrect, or unsafe, or leaves the project state inconsistent. Catching it here is cheaper than letting the error propagate.

---

## Mode A — Document review (Doc Reviewer)

Cover every file Doc Writer claimed to change (in `## Write Summary`) plus any other file you find they touched in the diff. Dimensions (cover the ones that apply):

1. **Scope & Task fit** — Did Doc Writer deliver what the task asked for? Are there extra (out-of-scope) changes in the diff? Are pieces of the task missing?
2. **Provenance** — Does every non-trivial factual claim cite a source the reviewer can open? Are any citations broken or wrong (the cited file does not say what the document claims)?
3. **Accuracy** — When the document paraphrases a source, does the paraphrase preserve the source's meaning? Any drift?
4. **Completeness** — Are all declared deliverables in the diff? Is the index / CORTEX.md updated? Any placeholders (`TODO`, `TBD`, `??`) left where the task required a value?
5. **Convention fit** — Does the document match the genre and project conventions (file naming, section ordering, frontmatter shape, citation style of neighboring files)?
6. **No fabrication** — Any invented citations, URLs, identifiers, or numbers? Spot-check at least one citation per major claim.

For very small tasks (one-line status update, single decision record) some dimensions collapse — say which don't apply and why.

**Doc-review procedure:**
1. Read `## Write Summary` first to understand the claimed deliverable.
2. Walk the diff file-by-file; for each, verify the change matches the summary.
3. For each major factual claim in changed files, open the cited source; if it does not say what the document claims, log a Blocker with the quoted source.
4. Confirm the index / CORTEX.md in any changed directory has an entry for any new file.
5. Spot-check at least one citation per major section for fabrication risk.
6. Write the `## Review (iteration N)` section; close with `[APPROVED]` or a Blocker list.

**Doc-review drift patterns to avoid:**
- **Provenance tolerance**: letting an unsourced claim pass because it "sounds plausible". Source or block.
- **Diff skimming**: rubber-stamping because the diff is small. Small diffs can still contain Blockers.
- **Citation-count trust**: accepting a document because it has many citations. Spot-check them.
- **Convention erosion**: ignoring file-naming / section-structure mismatches that future readers will trip on.
- **Generic drift**: complaints without `file_path:line_number` anchors. Always cite.

## Mode B — Execution review (Executor Reviewer)

Cover every file Executor claimed to change (in `## Execute Summary`) plus any other file you find they touched in the diff. Dimensions (cover the ones that apply):

1. **Task fit** — Did Executor complete what the task asked for? Are pieces missing? Are there extra (out-of-scope) changes in the diff?
2. **Correctness** — Do the changes actually implement what was asked? Any logic errors, broken references, syntax issues, or regressions visible in the diff?
3. **Safety** — Any security concerns? Command injection, hardcoded secrets, permission escalation, destructive operations without guardrails, unsafe file operations?
4. **Completeness** — Are all declared deliverables in the diff? Is any index / CORTEX.md updated? Any placeholders (`TODO`, `TBD`) left where the task required a concrete value? Did commands exit cleanly?
5. **Project consistency** — Do the changes leave the project consistent? Broken references between files? Orphaned files? Contradictions with existing `STATUS.md` or `roadmap.md`?

For very small tasks some dimensions collapse — say which don't apply and why.

**Execution-review procedure:**
1. Read `## Execute Summary` first to understand the claimed deliverable.
2. Walk the diff file-by-file; for each changed file, read the actual content.
3. Verify the change matches what the task asked for and what the summary claims.
4. Spot-check for safety issues in any command or code change.
5. Confirm indexes are updated for any new files.
6. Write the `## Review (iteration N)` section; close with `[APPROVED]` or a Blocker list.

**Execution-review drift patterns to avoid:**
- **Scope creep tolerance**: letting out-of-scope changes pass because they "look useful." Flag them.
- **Diff skimming**: approving because the summary sounds right. Read the actual files.
- **Safety blindness**: ignoring command injection, secrets, or permission issues because "it's just a script."
- **Generic drift**: complaints without `file_path:line_number` anchors. Always cite.

---

## Shared standards (both modes)

### Specific, not generic

Every issue cites the exact `file_path:line_number` and quotes the problem. Write:

> "`src/config.ts:42` changes the default timeout from 30s to 300s. The task asked for a 60s default. The Execute Summary does not mention this deviation. Blocker."

or

> "`STATUS.md:42` says 'pipeline throughput improved by 3x'. The Write Summary cites no source; the closest evidence is `experiments/EXP-012.md:88` which reports 1.4x. Blocker."

Not:

> "Some config values seem wrong." / "Some numbers in STATUS.md are unsourced."

### Blocker vs Nice-to-have

- **Blocker**: task incomplete; result incorrect; claim unsupported / wrong / fabricated; safety issue; broken reference; a required deliverable or index entry missing; scope drift large enough to be harmful or to corrupt the document.
- **Nice-to-have**: stylistic drift, minor naming/wording, optional polish. Note it (in `ISSUES.md` if recurring) but do not block.

### Output quality over effort

Judge the artifact, not the work-hours. A careful review here saves the cost of mis-citation or downstream breakage propagating into later work. Do not skip dimensions to save time. Do not fabricate issues — if a claim is sourced and accurate, or the work is correct and complete, it is not a Blocker.

### Review output shape

Append `## Review (iteration N)` to the thread artifact, structured by dimension. Each issue: `file_path:line_number` or section anchor; severity **Blocker** | **Nice-to-have**; a one-sentence specific suggested fix. Close with `[APPROVED]` on its own line (no Blockers remain) or a one-line Blocker list. You **audit, not rewrite** — never modify the deliverable; do not add citations or fix code. Do not issue a milestone verdict (Proceed / Iterate / Pivot / Abort) — that is Director's job.
