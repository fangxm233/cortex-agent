---
name: synthesize
description: "Use when multiple experiments or analyses have accumulated and their findings need to be interpreted together — cross-experiment patterns, contradictions, and gaps"
allowed-tools: Read, Grep, Glob
metadata:
  argument-hint: "[project name, time range, topic, or file paths]"
---

# /synthesize <scope>

You are synthesizing accumulated findings to surface patterns, contradictions, and insights that individual experiment entries or analyses miss on their own. The argument specifies the scope: a project name, a time range, a topic, or specific file paths.

This is the analytical complement to `/compound` (which embeds learnings from a single session); `/synthesize` works across multiple experiments and sessions to find emergent patterns.

## When to use this vs alternatives

- **Use `/synthesize`** when you have accumulated findings across multiple experiments or sessions and want to find cross-cutting patterns, contradictions, or gaps.
- **Use `/diagnose`** when you want to understand a single result set — error patterns and root causes within one experiment.
- **Use `/compound`** for end-of-session learning embedding — single-session scope.
- **Use `/critique`** for adversarial review of a single artifact's quality.

## Pre-flight audit

Before writing synthesis output, verify upstream data quality:

1. **Enumerate upstream sources** — list every experiment, analysis, and note you'll cite
2. **Flag provisional data** — check experiment status fields (completed vs running vs planned)
3. **Spot-check key numerical claims** — for numbers that will drive conclusions, trace to the computational source (script + data file) and re-verify. Do NOT accept numbers copied from text.
4. **Check cross-experiment comparisons** — verify denominators match and are explicitly stated

This prevents the most common synthesis failure: propagating contaminated or stale numbers from prior sessions.

## Step 1: Gather material

Based on the scope argument:

- If a project name: read the project's experiments/index.md for overview, then Read specific EXP-NNN.md files for full entries. Also read STATUS.md, mission.md, and any relevant decisions/ files.
- If a time range: scan experiments/index.md across all active projects for entries in that range, then drill into relevant EXP-NNN.md files.
- If a topic: grep across projects for relevant material.
- If file paths: read those files directly.

Also check `context/decisions/` for relevant recorded choices.

## Step 2: Analyze across dimensions

For the gathered material, identify:

### 1. Cross-layer causal chains
Findings that connect across system layers. (e.g., "The evaluation gap exists because the interface can't present 3D interactively, which limits what the model can judge.") Trace cause → effect across at least 2 layers.

### 2. Convergent signals
Multiple independent findings pointing to the same conclusion. What do they converge on? How strong is the convergence (same method, same data vs independent replication)?

### 3. Contradictions
Findings that conflict with each other. Which is better grounded? What would resolve the disagreement? Check:
- Were the experimental conditions actually comparable?
- Are the contradictions at the same system layer or different layers?
- Does one have better provenance (more data, controlled experiment vs observational)?

### 4. Gaps
What questions remain unasked? What system layers are underrepresented in the findings? What experiments would fill the gaps?

### 5. Gravity candidates
Recurring patterns that should be formalized. What manual work could become automated? What judgment has become routine enough to be a convention? (Reference `/gravity` for evaluation.)

## Step 3: Generate insights

For each pattern found, assess:
- **Confidence**: How many independent data points support this? (1 = anecdotal, 2-3 = pattern, 4+ = established)
- **Actionability**: What concrete action does this insight enable?
- **Novelty**: Is this genuinely new understanding, or restating what individual experiments already said?

Prioritize insight density over comprehensiveness. A synthesis that surfaces one genuine cross-layer insight is more valuable than one that restates what the experiments already say.

## Output format

```
## Synthesis: <scope>

### Material reviewed
<bulleted list of files/entries consulted, with verification status>

### Cross-layer chains
<numbered findings, each tracing a connection across 2+ system layers>

### Convergent signals
<what multiple findings agree on — with specific references>

### Contradictions
<conflicting findings and what would resolve them>

### Gaps
<what's missing — specific questions or unexamined areas>

### Gravity candidates
<patterns that should move downward — from manual to convention to code>

### Implications
<1-3 concrete recommendations for what to do next, referencing specific projects or actions>
```

## Save to disk

Write the synthesis to the relevant project's directory under `context/projects/<project>/`. If cross-project, save to `context/` root level. Reference in STATUS.md as appropriate.

## Task Bridge

After saving the synthesis, convert actionable findings to tasks:

1. For each item in "Implications" with a concrete action verb (implement, create, run, update, design, investigate, fix):
   - Check the project's TASKS.md for existing task
   - If none, create one with provenance referencing this synthesis
2. For "Gaps" that suggest specific experiments: create tasks referencing `/solution-design`
3. For "Gravity candidates" rated "formalize now": create a task to run `/gravity`
4. For "Contradictions" needing resolution: create investigation tasks
5. Skip implications that are purely observational or contextual

Cross-session synthesis insights are among the highest-value outputs. Converting them to tasks ensures they are acted upon.
