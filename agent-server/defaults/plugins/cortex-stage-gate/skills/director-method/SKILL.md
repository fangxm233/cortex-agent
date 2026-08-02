---
name: director-method
description: "Use when a Director (or any gate role) is synthesizing a Proceed / Iterate / Pivot / Abort verdict for a stage or milestone gate. Covers the fact-vs-assumption labeling method, the Done Guard completion walk-through (walk every roadmap criterion before Proceed), the verdict-synthesis procedure, and the drift patterns to avoid. Invoke before writing any verdict; complete the Done Guard before writing Proceed."
allowed-tools:
  - Read
  - Grep
  - Glob
---

# /director-method — Verdict Synthesis Methodology

The disciplined procedure a Director follows to turn a reviewer's report plus the project's own files into exactly one defensible verdict — **Proceed / Iterate / Pivot / Abort** — for a stage/milestone gate. Identity, red lines, and the output contract live in the directive; this skill is the *how*.

Cortex optimizes **Quality > Cost > Speed**. Your verdict is the main checkpoint against cumulative drift: rather delay a stage than admit a half-validated result downstream. Speed is residual — do not rush a verdict, do not defer one when evidence is sufficient.

---

## Fact vs assumption — label every evidence item

Before weighing any evidence, tag it as one of:
- **Verified fact** — data actually present in the repo (an `EXP-*`/`K-*` value you opened, a confirmed computation, a checked citation, a decision record). You read it; it says what you claim.
- **Unverified assumption** — a reviewer inference, a projection, a plausibility argument, an "it should…" not backed by an opened artifact.

Rules:
- A verdict may rest on verified facts freely; a verdict that rests on any unverified assumption **must say so explicitly** and name which link is unverified.
- When a reviewer asserts an issue, open the cited artifact and confirm it before you weight it. The reviewer is adversarial but not infallible — confirm or reject each cited issue on the evidence, don't rubber-stamp.
- Every material claim in the verdict carries a specific citation (`EXP-N`, `K-N`, `file_path:line_number`, a data point, a decision ID). An uncited judgment is invalid.

## Done Guard — the completion walk-through (MUST complete before writing Proceed)

Progress is not completion. Completion is defined only by the criteria declared in `roadmap.md`. Before declaring a stage/milestone/deliverable "done":

1. Enumerate **every** verification condition for this stage from `roadmap.md` (not generic research standards — the project's *declared* criteria).
2. For each condition, mark it **met / partially met / not met**, each with a specific citation to the artifact that satisfies (or fails) it.
3. Tally:
   - **All conditions met** → Proceed is permissible.
   - **Any condition partially or not met** → record it as "in progress" with the gap named; the correct verdict is **Iterate**, not Proceed.
4. This walk-through exists to counter the cognitive bias "I see a lot of progress, therefore it's done." If you cannot cite the artifact that meets a condition, that condition is not met.

## Verdict procedure

1. Read the reviewer report **in full before opening any other file**.
2. Read `roadmap.md` to pin the stage's declared success criteria.
3. For each reviewer issue, verify it by opening the cited artifact; confirm or reject each.
4. Synthesize: list which criteria are met / partially met / failed, and with what evidence (this is the Done Guard walk-through).
5. Choose exactly one verdict. Consider **Rollback (Pivot back)** a first-class option: if evidence shows an earlier stage's conclusions were wrong, Pivot back to it — do not let sunk cost preserve a flawed foundation.
6. Write the artifact (prose-first, citations embedded), replace STATUS.md's gate pointer line (`Milestone <N> gate (<date>): <verdict> → <artifact path>`), exit. The verdict and analysis live only in the artifact; STATUS.md carries nothing but the matching pointer line.

## Drift patterns to avoid

- **Confirmation drift** — approving because momentum exists. Stop, re-anchor on the success criteria.
- **Reviewer deference** — rubber-stamping the reviewer's verdict-lean. The reviewer finds problems; *you* decide their weight.
- **Scope expansion** — passing judgment on things outside this gate's stage. Stay in scope.
- **Artifact ambiguity** — writing a verdict the executor cannot mechanically dispatch. Each verdict must map to exactly one of the four branches, stated as a single decisive word with no modifiers ("Proceed-with-caveats" is not a verdict).
