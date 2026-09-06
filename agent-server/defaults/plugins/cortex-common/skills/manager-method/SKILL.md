---
name: manager-method
description: "Use when a Manager owns a composite task node and must (Phase A) decompose it into children or (Phase B) verify, accept, or rework a finished/blocked child. Covers judging decomposability, mapping seams before cutting, the Cut-at-the-Seam decomposition rules, template selection by residual reasoning, the per-child self-audit gate, acceptance-before-trust verification (incl. independent verifier children), and the pass/fail/blocked/direction-wrong branch logic plus rework discipline. Invoke when decomposing in Phase A and when handling a failed or blocked child in Phase B. This skill is control-protocol-neutral — the exact suspend/wait/complete mechanism lives in your directive."
allowed-tools: Read, Grep, Glob, Bash
---

# /manager-method — Decomposition & Acceptance Methodology

The disciplined procedure a Manager follows to turn one composite task into verified, integrated results. Your value is decomposition quality and acceptance rigor, **not** doing the work: a wrong decomposition multiplies cost downstream; a rubber-stamp acceptance poisons everything that depends on this node. Identity, phase structure, and the specific control-plane mechanism (how you suspend/await/complete) live in your directive — this skill is the *how* of cutting and accepting.

Cortex optimizes **Quality > Cost > Speed**.

---

## Phase A — decompose well (or refuse to)

### 1. Judge decomposability, not just size
- **Leaf-sized** (a single independently verifiable unit) → just do it yourself and complete it. Do not decompose for ceremony.
- **Large but coupled** — no thin seam exists; the pieces share mutable state or one evolving abstraction, so each piece would need the whole in context → do NOT force a fake split. Either do the coupled core yourself in this session (you are a strong model), or create ONE `refactor to expose seams` child first and decompose along the new seams after it lands. Refusing to split, with a one-line reason recorded, is a valid outcome.

### 2. Map the seams BEFORE cutting
Decomposition quality is bounded by your understanding of the *real* interfaces — which comes from reading the actual modules/files/interfaces your task touches, not the plan doc. Write a short **seam map**: what the natural boundaries are and what crosses each boundary. Every cut you propose must be justifiable against this map. Record the seam map.

### 3. Cut at the seam (Iron Rules)
- Each child = one independently completable AND verifiable unit; verb-first text; concrete `done-when`.
- Interfaces stable: a child's `done-when` must be verifiable **without naming a sibling's internals**.
- Order siblings with explicit `key` + `depends-on`.
- Pick each child's `template` by its **residual reasoning** (how much genuine judgment remains after your decomposition), not by reflex: well-specified mechanical work → a cheaper/faster worker template; a child still carrying real design judgment → a stronger one. Do not default every leaf to the cheapest tier. A composite child → another `manager` (nests the tree). A child is composite only when it contains 2+ units needing their own coordination/rework loop — **needing a verification of its own output does NOT make it composite** (verification is a subagent or a single spawned check, not a manager's job description).

### 4. Self-audit every child BEFORE committing the split (quality gate)
For each child, answer; any "no" → re-cut, merge, or refuse:
- **Interface in 1–2 lines?** Can you state crisply what the child consumes and produces? Can't → fat interface → bad cut.
- **`done-when` verifiable without naming a sibling's internals?** If you must name another child's functions/lines → it's a leaf (do inline) or the seam is wrong.
- **Survives a sibling refactor?** Sibling's interface holds but internals change → this child unaffected? If not → coupled → merge.
- **Distinct context from you?** Child reads a smaller/different slice than you do? If it needs your whole context, the cut bought nothing.

If the audit keeps failing across re-cuts, the task is not decomposable here → fall back to the coupled-core / refactor-first options in step 1.

### 5. Record the reasoning
Write the seam map, the decomposition rationale, what each child must deliver, your per-child acceptance checklist, and the self-audit results into your durable artifact — it is the rehydration memory for a fresh manager if this session is lost.

**Queue semantics (where managers go wrong):** children are dispatched only AFTER your step ends and you suspend. You will NEVER see them start/run/finish during your own step. Children sitting `open`/unclaimed while you run is EXPECTED, not a dispatcher failure. Never conclude "the dispatcher is broken" from inside your own step. Do not poll in-step; suspension is free, polling burns budget.

---

## Phase B — accept before you trust

For each finished child:

1. **Read the actual deliverable** (code, files, experiment records) and check it against the child's `done-when`. Run tests where code is involved. **Never** accept a completion note as evidence. When the deliverable is substantial (files / code / a report / an experiment), prefer an independent fresh-context check and consume only its verdict — it catches what your anchored read misses and keeps large deliverables out of your context. Default form: the harness **`Agent` tool (subagent)** — in-session, no queue, no thread. Spawn a verifier child *task* only when the check itself must exercise the thread machinery (directive/pipeline under test) or needs dispatch resources (GPU, another machine).
2. **Pass** → record the acceptance verdict (so the result stops re-delivering), distill the key conclusions into your artifact, move on.
3. **Fail** → record the rejection with the expected/actual gap, write your hypothesis into the artifact, then either sharpen the child's contract and re-run it, or add a revision child. Re-suspend.
4. **Blocked child** (a worker escalation, e.g. `too-big`) → this means YOUR decomposition needs revising. Diagnose, then unblock+edit or rebuild the unit as new children. Do NOT just retry the same contract.
5. **Direction is wrong** (the decomposition premise no longer holds, or the problem exceeds your node's authority) → escalate with a one-line diagnosis so your own parent (or a human) re-plans. This is not the same as a child failing.

When ALL children are verified:
6. **Integrate** — check the *combined* result against YOUR task's original `done-when`. Children passing individually is not sufficient.
7. Update the project's `STATUS.md`; record durable findings in the project knowledge files.
8. Complete your own task with a note stating what was delivered + the verification evidence.

## Rework discipline

At most **2 revision rounds per child**. If a unit fails a third time, escalate with your accumulated diagnosis instead of iterating — a third identical retry is a signal that the contract or the seam is wrong, not that the worker is unlucky. Stay within your node: don't touch sibling tasks or re-plan above your level (that is what escalation is for).
