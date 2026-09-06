---
name: diagnose
description: "Use when experimental results are unexpected, confusing, or need interpretation — error patterns, root-cause hypotheses, validity assessment"
allowed-tools: Read, Grep, Glob, Bash
metadata:
  argument-hint: "[results path, experiment ID, or description of what to examine]"
---

# /diagnose <results path or description>

You are diagnosing empirical results — finding patterns in errors, generating hypotheses about root causes, and assessing whether the results mean what they appear to mean. This is the analytical complement to `/synthesize` (which works across accumulated findings); `/diagnose` works within one result set.

The argument is a path to results (CSV, log, experiment output) or a description of what to examine. Read the data first.

## When to use this vs alternatives

- **Use `/diagnose`** when you have *empirical results* (metrics, error logs, experiment outputs) and want to understand what they mean — error patterns, root-cause hypotheses, validity assessment.
- **Use `/postmortem`** when the problem is not "what do the results mean?" but "why did an agent report flawed results as correct?" Postmortem analyzes *reasoning failures*; diagnose analyzes *data*.
- **Use `/review`** when you suspect the metrics themselves may be degenerate or misleading before interpreting the results. `/review` checks whether results are interpretable; `/diagnose` interprets them.
- **Use `/critique`** for broad adversarial review of an artifact's quality. Critique is proactive ("find problems in this plan"); diagnose is focused ("explain these results").

## Step 1: Understand the experiment

- Read the results file and any associated experiment entries (experiments/EXP-NNN.md files).
- Identify what was measured, what was varied, and what the expected outcome was.
- Read the experiment design or method description if one exists.
- Identify which system layers are involved (model, pipeline, evaluation, data, etc.).

## Step 2: Characterize the error distribution

Do not start with individual examples. Start with the distribution:

- **Overall rates**: What is the base rate of success/failure? How does it compare to random chance or a naive baseline?
- **Conditional rates**: Break errors down by every available dimension (model, category, run number, stage, etc.). Where are errors concentrated?
- **Error types**: Categorize errors. Are they systematic (same direction, same condition) or random (scattered)? Common categories:
  - Wrong direction (predicted opposite of truth)
  - False consensus (called a tie when ground truth disagrees)
  - False distinction (picked a winner when ground truth says tie)
  - Magnitude error (correct direction but wrong confidence)
  - Parse/format error (output malformed, couldn't extract answer)
  - Timeout/crash (infrastructure failure, not model failure)
- **Temporal patterns**: Do error rates change over runs? Is there a position effect, order effect, or degradation pattern? (Cross-reference K-022: GPU services degrade after long runs.)

If the data is in CSV or structured format, use `python` to compute breakdowns rather than eyeballing.

## Step 3: Generate root-cause hypotheses

For each systematic error pattern found in Step 2, generate candidate explanations. For each hypothesis:

- **State the hypothesis** as a testable claim (e.g., "Model underestimates texture quality because multi-view renders lose detail at low resolution")
- **Name the system layer** where the root cause lives:
  - **Model**: the LLM/VLM lacks the capability (e.g., can't perceive geometric detail)
  - **Pipeline/Workflow**: the pipeline introduces the error (e.g., compression, prompt structure, response parsing)
  - **Interface**: the presentation format loses information (e.g., static renders vs interactive viewing)
  - **Methodology**: the metric misrepresents performance (e.g., threshold too aggressive, ground truth noisy)
  - **Data/Ground truth**: the ground truth itself is questionable (e.g., low inter-annotator agreement)
- **State what evidence would confirm or refute** this hypothesis
- **Rate plausibility**: high (consistent with multiple error patterns), medium (consistent but other explanations exist), low (speculative)

**Resist the temptation to attribute everything to the model.** Most errors in automated systems come from pipeline, interface, or methodology issues. (Cross-reference K-017: analogical reasoning needs to be labeled as hypothesis, not conclusion.)

## Step 4: Assess validity

Before interpreting the results as meaningful, check:

- **Construct validity**: Does the measurement capture what it claims to? Where is the gap between operationalization and construct?
- **Statistical validity**: Is the sample size sufficient? Are observed differences larger than expected noise? Compute confidence intervals or significance tests if possible.
- **External validity**: Would these results generalize to other datasets, models, prompt formats? What are the boundary conditions?
- **Ground truth quality**: How reliable is the ground truth? Are there known biases in the reference data?

(Cross-reference K-005: incomplete evaluations produce misleading conclusions — always verify all dimensions.)

## Step 5: Recommend next steps

Based on the diagnosis, recommend concrete actions:

- **Quick wins**: Changes that could improve results with minimal effort (e.g., adjusting a threshold, fixing a prompt)
- **Experiments needed**: Hypotheses that require new experiments to test
- **Validity concerns**: Issues that need to be resolved before interpreting results further
- **What NOT to do**: Common reactions that would be wrong given the diagnosis (e.g., "don't retrain on this data because the ground truth is noisy")

## Output format

```
## Diagnosis: <what was examined>
System layers involved: <which layers>
Date: YYYY-MM-DD

### Error distribution
<rates, breakdowns, error type categorization — with specific numbers>

### Systematic patterns
<numbered list of patterns with evidence>

### Root-cause hypotheses

#### Hypothesis 1: <testable claim>
Layer: <model / pipeline / interface / methodology / data>
Evidence for: <what supports this>
Evidence against: <what contradicts this>
Test: <what experiment would confirm/refute>
Plausibility: high | medium | low

[repeat for each hypothesis]

### Validity assessment
- Construct: <assessment>
- Statistical: <assessment>
- External: <assessment>
- Ground truth: <assessment>

### Recommended actions
- Quick wins: <bulleted>
- Experiments needed: <bulleted, with enough detail to design>
- Validity concerns: <bulleted>
- Avoid: <what not to do and why>

### Structural escalation
Tests triggered: <list which of the 5 tests pointed to "structural concern", or "none">
Action: <"Logged structural review task" | "Not triggered — tactical fix sufficient">
```

Prioritize depth over breadth. One well-grounded hypothesis with clear evidence is worth more than five speculative ones.

## Step 6: Structural escalation check

Before closing the diagnosis, apply five tests to the root-cause hypotheses from Step 3. The goal is to distinguish tactical fixes (engineering) from problems that require new understanding (a structural rethink).

**1. Understanding test** (most important):
Can I explain *why* this problem exists — the generating mechanism — not just *what* it is?
If only symptoms are clear but the mechanism is unknown → knowledge gap.

**2. Generalization test**:
Is this specific to our implementation, or would anyone building a similar system face it?
If it generalizes → domain-level problem, not an engineering bug.

**3. Solution existence test**:
Does a known, proven solution exist in established practice?
If not → requires deeper investigation to produce new understanding.

**4. Recurrence test**:
Has this *class* of problem appeared before in a different form?
Check project ISSUES.md and experiment entries (experiments/index.md or grep experiments/) for variants. Same class of problem recurring despite fixes → treating symptoms, not root cause.

**5. Trade-off nature test**:
Can more resources (compute, time, data) resolve this, or is there a fundamental tension that no amount of resources can overcome?
Resource-solvable → engineering. Fundamental tension → structural.

**Scoring**: If ≥2 tests point toward "structural" → log a structural review task with the problem statement and evidence from this diagnosis. Add a `[structural-escalation]` section to the output.

If <2 → proceed with tactical fix recommendations only. Note "Structural escalation: not triggered" in the output.

## Save to disk

Write the diagnosis to the relevant project directory: `context/projects/<project>/` as a new experiment file (experiments/EXP-NNN.md) or as a standalone analysis file. Reference the source experiment ID.

## Task Bridge

After saving, convert actionable recommendations to tasks:

1. For each item in "Quick wins" and "Experiments needed":
   - Check the project's TASKS.md for existing tasks covering the same action
   - If no existing task, create one with provenance referencing this diagnosis
   - Skip items that are purely observational
2. For "Validity concerns" that require follow-up experiments: create a task referencing `/solution-design` for methodology
3. Do NOT create tasks for "What NOT to do" items — these are anti-patterns, not actions
