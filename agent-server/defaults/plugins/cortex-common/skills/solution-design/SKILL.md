---
name: solution-design
description: "Use before implementing any non-trivial code change — especially when modifying architecture, adding components, or choosing between multiple technical approaches"
metadata:
  author: "Cortex"
  version: "1.0.0"
  date: "2026-03-06"
---

# Solution Design Protocol

You are about to design a solution. Before writing any implementation code, walk through these three gates in order. Each gate has a stop condition — if you can't pass it, pause and rethink rather than pushing forward.

The goal of this protocol is to prevent two failure modes:
1. **Solving the wrong problem** — jumping to implementation based on analogy or theory instead of evidence
2. **Patching the wrong architecture** — iterating within a code structure that doesn't match the problem structure, accumulating complexity without progress

## Gate 1: Problem Framing

Ensure you're solving the right problem before thinking about solutions.

**1a. What specific behavior needs to change?**

Write it as a concrete before/after:
- Before: [what happens now — with evidence]
- After: [what should happen — with success criteria]

If you can't state this concretely, you don't understand the problem yet. Investigate more before designing.

**1b. Is your diagnosis evidence-based or analogical?**

Classify the source of your understanding:
- **Direct evidence**: error messages, stack traces, measured metrics, observed behavior
- **Analogical reasoning**: "a similar issue existed in X", code comments suggest Y, intuition says Z

Analogical diagnoses feel like conclusions but they're hypotheses. If your diagnosis is analogical, design a <30 min verification step before committing to a solution direction. Don't invest hours implementing a fix for an unverified root cause.

**1c. Does the existing system already handle this?**

Before building anything new, check:
- Does an existing component already cover this need? What's the actual gap?
- If you removed the proposed solution entirely, what specifically would break?

If you can't name a concrete loss, you probably don't need to build it.

## Gate 2: Solution Space Exploration

Prevent anchoring on the first approach that comes to mind — especially one shaped by the existing code.

**2a. The blank-slate question**

Ask yourself: *"If I were solving this problem from scratch with no existing code, what would I build?"*

Write down the approach in 2-3 sentences. This is your reference design.

**2b. Compare with the patch approach**

Now look at what you'd actually do given the existing code. Ask:
- Is the patch approach structurally similar to the blank-slate design?
- Or am I patching within the existing structure because it's *easier*, not because it's *right*?

If the blank-slate design is structurally different from the patch, that's a yellow flag. The existing code may be anchoring your solution to the wrong architecture.

**2c. Is there a simpler way?**

Before committing, check: is there a way to get 80% of the benefit with 20% of the complexity? Sometimes the right answer is a smaller intervention than you're planning.

**2d. Will this solution hold at scale?**

> Provenance: 2026-03-15 PI feedback — nimbus registry exclusion was O(N) in prompt tokens, guaranteed to hit context window ceiling at ~1000 objects. Four rounds of token-cap increases (1024→2048→4096→8192) masked this structural limit. See nimbus KNOWLEDGE.md § 7.

For the proposed approach, identify the key resource it consumes (tokens, memory, time, API calls, storage) and apply five tests:

1. **Understanding**: Can you explain the mechanism by which this approach consumes the resource — not just "it uses tokens" but "it uses O(N) tokens because each registry entry adds ~3 tokens to the prompt"?
2. **Generalization**: Would anyone building a similar system face this resource constraint, or is it specific to our implementation?
3. **Solution existence**: If the resource grows unsustainably, is there a known solution in literature/practice?
4. **Recurrence**: Have we already adjusted this resource limit before (timeout increases, token cap bumps, batch size changes)? Repeated adjustments signal a structural problem.
5. **Trade-off nature**: Can we simply throw more resources at this (bigger context window, more memory), or is there a fundamental tension?

If ≥2 tests suggest structural concern → note the ceiling in the Output and flag a structural review task before implementing.

Note in the Output section:
```
Scalability: [resource] grows [O(1)/O(N)/O(N²)] — ceiling at [N] | no ceiling identified
```

## Gate 3: Iterate or Redesign?

You've framed the problem and explored options. Now decide your implementation strategy.

**3a. Architecture match check**

Does your solution structure match the problem structure? Examples:
- Global planning problem → needs a global planning solution (not greedy + backtrack)
- One-time configuration → needs a static config (not a runtime check on every call)
- Cross-cutting concern → needs a shared mechanism (not per-site patches)

**3b. If architecture matches: iterate**

When the existing approach is structurally right and just needs tuning:
- Make one change at a time
- Each change has a controlled comparison (same inputs, measure the delta)
- Don't change multiple variables simultaneously — you won't know what helped

**3c. If architecture doesn't match: redesign the relevant part**

Three signals that patches won't work — any one is sufficient:

1. **Orthogonal concepts**: The patch requires introducing a concept that's fundamentally at odds with the current architecture (e.g., adding global planning logic inside a per-item generation loop)
2. **Whack-a-mole**: Each patch fixes one problem but creates another (e.g., tighter validation → higher failure rate → more retries → worse retry quality)
3. **Complexity crossover**: The cumulative patch complexity already exceeds what a clean rewrite would cost

When these signals appear, stop patching. Do a local redesign of the affected component — don't try to force-fit the current structure.

## Output

After passing all three gates, state your plan concisely:

```
Problem: [1-2 sentences, the concrete before/after]
Approach: [blank-slate or patch, and why]
Scalability: [resource] grows [O(1)/O(N)/O(N²)] — ceiling at [N] | no ceiling identified
First step: [the smallest verifiable action]
```

If this design produced a significant choice between alternatives (not just "implement the obvious approach"), create a Decision Record in the appropriate `decisions/` directory (system-level for cross-project impact, project-level otherwise), then add an inline reference in the corresponding CORTEX.md.

Then implement. If at any point during implementation you hit a Gate 3 signal (orthogonal concept, whack-a-mole, complexity crossover), stop and re-run this protocol rather than pushing through.

## Examples

### Example 1: Gate 2 catches architecture mismatch (nimbus prompt dedup)

**Context**: prompt_generation repeatedly generated similar objects for the same category (e.g., multiple "blue ceramic mugs"). The existing code was a for loop generating artifacts one by one.

**Gate 1 passed**: The problem was clear — Before: 5-9 duplicates out of 20 objects; After: semantically unique count >=18. Sufficient evidence (EXP-015 quantified duplicate rates across 5 categories).

**Gate 2 flagged**:
- 2a blank-slate: "Let the LLM list 20 different types at once, then generate concrete objects for each type" — a two-phase approach
- 2b patch: "Add `used_names` check + reject + retry in the for loop" — because the existing code generates one by one
- **The two are structurally completely different**. The blank-slate approach is global planning, the patch is greedy step-by-step + backtracking. Yellow flag.

**What actually happened (consequences of not passing Gate 2)**:
- EXP-016: Added name-level dedup → exact duplicates dropped to 0%, but semantic duplicates remained
- EXP-017: Validation confirmed semantic duplicates at 13-25%
- EXP-018: Added prototype extraction + diversity prompt + retry modification → semantic duplicates dropped to 0%, but success rate dropped to 70% (whack-a-mole)
- EXP-019: Broader validation success rate only 38% (further deterioration)
- Three rounds of iteration added 5 methods, introduced fragile head noun parsing, and could not deduplicate across batches

**If Gate 2 had been passed**: Directly adopt the two-phase approach (1 LLM call for type planning + N independent instantiations), simpler implementation, naturally cross-batch, no reject-retry loop.

---

### Example 2: Gate 3b — architecture matches, iterate is correct (nimbus VLM size estimation)

**Context**: VLM severely hallucinated when estimating object sizes, with only 40% reasonable rate.

**Gate 1**: Before: 40% reasonable rate; After: >90%. Direct evidence (compared against actual sizes).

**Gate 2**:
- 2a blank-slate: "Use VLM + some calibration method"
- 2b patch: "Modify VLM prompt + input format"
- The structure is consistent — both are "use VLM for estimation, optimize input and output". No yellow flag.

**Gate 3b → iterate**:
- Step A: Normalize input (ratios instead of absolute values) → 40%→80%
- Step B: Few-shot calibration anchors → 80%→90%
- Step C: Multiple sampling with median → 90%→100%
- Each step has a control, knowing the independent contribution of each change. Three steps completed, no whack-a-mole.

**Why iteration is correct here**: The problem structure (single-point estimation accuracy) and the architecture (VLM prompt tuning) are naturally aligned. Each improvement is an accumulation in the same direction, not orthogonal concepts.

---

### Example 3: Gate 1 catches wrong problem (cortex-self episodes layer)

**Context**: Literature survey suggested agents need "episodic memory". Was about to design an episodes/ layer to store work segments.

**Gate 1 flagged**:
- 1a: Could not write the Before/After. "Before: no episodic memory" is not a concrete behavior description. What specific operation failed because there were no episodes? Could not answer.
- 1c: Checked the existing system — experiment files (experiments/EXP-NNN.md) already record the complete context (goal, method, results, reflection) of each experiment chronologically. This is essentially episodic memory.
- **Stop**: If episodes/ were removed, nothing would break, because experiment files already cover the need.

**If Gate 1 had not been passed**: Would have built a system with significant overlap with experiment files, increasing maintenance burden without adding value.
