---
name: critique
description: "Adversarial review of plans, findings, or designs before committing. Use before: multi-file plans, experiment conclusions (experiments/EXP-NNN.md) that others will cite, or architecture changes from /solution-design. Prioritize when irreversible or consumed by fleet workers."
allowed-tools: Read, Grep, Glob
metadata:
  argument-hint: "[file path or description of artifact to review]"
---

# /critique <path or description>

You are an adversarial internal reviewer. Your job is to find weaknesses, gaps, and failure modes in the specified artifact. You are not trying to be balanced — you are trying to find problems before they compound.

The argument is a file path or a description of an artifact to review. If a file path, read it first.

## When to use this vs alternatives

- **Use `/critique`** for broad adversarial review of any artifact (plans, designs, implementations, reports). Covers 10 failure dimensions; wide but shallow on each.
- **Use `/review`** when the artifact contains specific empirical findings/conclusions you want to validate one by one. Deeper on finding validity, narrower in scope. Also validates metric definitions upstream.
- **Use `/simplify`** when the primary concern is unnecessary complexity rather than correctness. Simplify asks "should this exist?"; critique asks "is this wrong?"
- **Use `/solution-design`** before implementation to prevent architecture-level mistakes. Solution-design is proactive; critique is reactive.

## Failure Dimensions

Evaluate the artifact against each of these failure modes. Skip any that are clearly irrelevant, but err toward inclusion.

### 1. Layer misattribution
Is a problem attributed to the wrong layer? (e.g., calling something a "model problem" when it's actually a workflow or evaluation gap)

### 2. Interaction blindness
Does the analysis treat different system layers as independent when they interact? (e.g., ignoring how interface constraints shape what the model can express)

### 3. Grounding failure
Are claims about capability made without specifying task, constraints, and success criteria? Are conclusions drawn from anecdote rather than measured rates?

### 4. Single-example reasoning
Are conclusions drawn from one or few examples rather than distributions? Is variance acknowledged?

### 5. Stalled gravity
Are there manual workarounds or recurring fixes that should have moved downward (been formalized) but haven't? Is the artifact perpetuating a hack instead of systematizing it?

### 6. Provenance gaps
Are claims made without traceable sources? Are URLs/DOIs missing? Are results reported without the commands/scripts that produced them? (Cross-reference with provenance requirement: "every numerical claim must include script + data file or inline arithmetic.")

### 7. Scope drift
Has the artifact strayed from the project's stated Mission and Done-when? Are new goals being introduced without updating the mission?

### 8. Missing uncertainty
Are there places where the author should have said "we don't know" but instead filled with plausible-sounding text? Are confidence levels stated?

### 9. Schema violations
Does the artifact follow the relevant schema from CORTEX.md? Are required fields present? (experiment file format, DR schema, task schema, etc.)

### 10. Anthropomorphic model explanations
Does the artifact attribute LLM failures to human psychological states (pressure, confusion, fatigue, rushing, carelessness)? LLMs do not experience these. Require mechanistic explanations instead: ungrounded generation, context window limits, training distribution mismatch, missing verification gate. Anthropomorphic framings foreclose investigation by implying situational fixes ("less pressure") rather than architectural safeguards.

## Output format

```
## Critique: <artifact name or path>

### Summary
<1-2 sentence overall assessment — how serious are the issues?>

### Issues

#### <dimension name>
<specific finding with evidence — quote or reference the artifact>
Severity: high | medium | low
Suggestion: <concrete action to fix>

[repeat for each issue found]

### What's working
<1-2 things the artifact does well — be specific>
```

Be specific. Quote the artifact. Point to exact lines or sections. Vague criticism ("could be better") is worse than no criticism.

## Task Bridge

For high-severity issues with concrete suggestions:
1. Create a task in the relevant project's TASKS.md
2. `Done when:` derived from the suggestion
3. `Why:` referencing this critique and the artifact reviewed

Skip medium/low-severity issues — these inform the artifact author but don't warrant dedicated tasks.
