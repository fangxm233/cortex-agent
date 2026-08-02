---
name: postmortem
description: "Use when an agent or pipeline produced a flawed output that was presented as correct — the question is 'why wasn't this caught?'"
allowed-tools:
  - Read
  - Grep
  - Glob
argument-hint: "[file path, log entry, or description of the failure]"
---

# /postmortem <path or failure description>

Analyze why an agent (LLM or pipeline) produced a flawed output. The goal is not to explain the technical mechanism but to identify the reasoning failure that led to the flaw being produced and not caught. The argument is a file path or description of the failure. Read relevant files first.

## When to use this vs alternatives

- **Use `/postmortem`** when an agent or pipeline produced a flawed output that was *presented as correct* — the question is "why wasn't this caught?" not "what went wrong in the data?"
- **Use `/diagnose`** when the focus is on understanding *empirical results* — error distributions, root-cause hypotheses, validity. Diagnose analyzes data; postmortem analyzes agent reasoning.
- **Use `/critique`** for a broad review of an artifact's quality. Critique is proactive ("find problems"); postmortem is reactive ("explain this specific failure").
- **Use `/debug-campaign`** for multi-round system debugging with multiple failure modes. Debug-campaign is strategic debugging; postmortem is single-incident reasoning analysis.

## Key distinction

The question is never "why is the output wrong?" — it is "why was this output presented as correct?"

A wrong prediction is expected. A wrong prediction reported as a finding, used to make a decision, or committed to the repo as fact is a reasoning failure worth analyzing.

## Procedure

### 1. Identify the flaw

State precisely what was wrong, with evidence. Quote the flawed output.

### 2. Trace the production chain

Walk backward through the chain that produced the flaw:
- **Who generated it?** (which agent, script, or pipeline step)
- **What inputs did they have?** (were the inputs sufficient to detect the flaw?)
- **What checks were skipped?** (was there a review step that should have caught it?)
- **What structural condition enabled it?** (missing verification gate, context window limits, anchoring on prior output, pattern-matching without verification, ungrounded generation beyond reliable recall)

### 3. Classify the failure mode

Which of these caused the flaw?

- **Design-as-discovery**: A constraint of the experimental setup was reported as an empirical finding. The agent failed to ask "could this have been different?"
- **Layer misattribution**: A property of one system layer was attributed to another (e.g., pipeline constraint reported as model behavior)
- **Momentum override**: The agent was executing a plan and did not pause to verify intermediate results. Production outpaced reflection.
- **Anchoring**: The agent saw a number or pattern and built a narrative around it without checking the generating process.
- **Missing mental model**: The agent lacked understanding of how the metric/system works and could not detect the flaw even in principle.
- **Context loss**: The relevant information existed but was not in the agent's working context when the decision was made (e.g., schema defined in a different file than the analysis).
- **Social proof**: The agent reported something because it looked like what a finding "should" look like, not because it was verified.
- **Ungrounded generation**: The model produced plausible but factually false content because autoregressive generation cannot distinguish retrieval from novel generation. This is the default behavior of foundation models, not a situational failure.

**Anti-anthropomorphism constraint:** Never attribute model failures to human psychological states (pressure, confusion, fatigue, rushing, carelessness). LLMs do not experience these. Use mechanistic explanations grounded in model architecture: ungrounded generation, token probability vs truth, context window limits, training distribution mismatch, missing verification gate. Anthropomorphic framings foreclose deeper investigation by implying the fix is "less pressure" rather than architectural safeguards.

(Cross-reference K-017: analogical reasoning must be labeled as hypothesis, not conclusion.)

### 4. Identify the prevention

What specific check, convention, or tool would have caught this flaw before it was produced?

- Is there an existing convention in CORTEX.md that was not followed?
- Should a new convention be added?
- Would a skill (`/review`, `/critique`) have caught it?
- Should the pipeline itself include a validation step?

If the prevention involves creating a Decision Record, and the DR includes unimplemented action items, create corresponding tasks.

### 5. Record model limits (if applicable)

If the failure mode involves model capability limitations (ungrounded generation, missing mental model due to capability gap), record it:

1. As a new knowledge entry (knowledge/K-NNN.md) in the relevant project
2. In the postmortem itself with evidence and mitigation
3. In the relevant project's STATUS.md under Blockers & Pending Decisions — one line + pointer to the K-entry, and only if it constrains current work

Skip this step only if the root cause is entirely at non-model layers.

## Output format

```
## Postmortem: <brief title>

### The flaw
<what was wrong, with direct quote>

### Production chain
1. <step> — <what happened>
2. <step> — <what happened>
3. <step> — <where the flaw was introduced or missed>

### Failure mode
<classified type>: <specific explanation>

### Root cause
<one sentence: why the flaw was produced AND not caught>

### Prevention
- Existing convention missed: <reference or "none">
- New convention needed: <specific proposal or "none">
- Skill that would catch this: <name or "none">
- Pipeline change needed: <specific proposal or "none">

### Downstream Impact
<If the postmortem corrects previously-reported findings, list downstream consumers.
Search: `grep -r "EXP-ID" context/` or `grep -r "erroneous value" context/`
Classify each: corrected | needs-update | no-impact
Create tasks for needs-update items.
Omit this section if the error did not produce any cited findings.>

### Severity
<high | medium | low> — <consequence if the flaw had not been caught>

### Model-limit notes
<"Recorded: <what was added/changed>" or "No model-layer component — skip">
```

## Save to disk

Write the postmortem under `context/projects/<project>/`. Reference it in the relevant experiment file (`experiments/EXP-NNN.md`) if related to a specific experiment.

## Task Bridge

After saving the postmortem, convert prevention actions to tasks:

1. For each item in the "Prevention" section:
   - If "New convention needed" → create a task to update the relevant convention/skill
   - If "Pipeline change needed" → create a task for the code change
   - If "Skill that would catch this" → check if the skill exists; if not, create a task
   - Check TASKS.md for existing tasks before creating duplicates
2. Tag each task appropriately with `[template: ...]` and lifecycle tags
3. Reference this postmortem in each task's `Why:` field

This ensures prevention actions are executed rather than rediscovered in future postmortems of the same failure mode.
