---
name: debug-campaign
description: "Use when debugging multi-round issues on pipelines, services, or complex systems, when a fix-test cycle has gone through 3+ iterations without convergence, or when encountering bugs that resist simple fixes"
metadata:
  author: "Cortex"
  version: "2.0.0"
---

# Debug Campaign Protocol

## Overview

This skill governs **multi-round debugging campaigns** — situations where you're not fixing a single bug but systematically improving a complex system's reliability across multiple sessions. The key insight: in multi-component systems, bugs layer like an onion. Fixing one layer reveals the next. Planning for this upfront is what separates efficient campaigns from thrashing.

**Complements `superpowers:systematic-debugging`**: That skill handles single-bug root cause investigation (read error → reproduce → trace → fix). This skill handles the strategic layer: when to instrument, what to fix first, how to verify, and how to plan across multiple fix cycles.

**Evidence base**: This protocol is distilled from 50+ debugging experiments across nimbus (19 bugs, 37 experiments), orchard (rendering pipeline bugs), and cortex-self (meta-debugging). Every rule has at least 2 independent real-world failures backing it.

---

## Part 1: Before You Start

### 1.1 Diagnostic Readiness (INSTRUMENT FIRST)

**Before fixing anything, ensure you can observe all failures.**

This is the single highest-leverage investment in a debugging campaign. Every hour spent here saves 3-5 hours of blind fix-test cycles later.

> *Evidence*: nimbus EXP-022→037 spent 7/16 experiments building diagnostics reactively (44% waste). Three independent logging bugs (B13/B16/B19) each blocked root cause identification until fixed. B16 fix revealed "VLA 100% failure was drop-platform check" — fundamentally changing the optimization direction.

#### Checklist

1. **Map all failure branches**
   - `grep` all `except`, `if not`, `return error`, `raise`, `response.success == False` paths
   - For each branch: does it produce a structured log entry or dump file?
   - If not → add instrumentation BEFORE doing anything else

2. **Ensure dump coverage at every layer**
   - **Service layer**: When an external call returns an error or empty response
   - **Processing layer**: When parsing/transformation fails on a non-empty response
   - **Orchestration layer**: When a stage marks items as failed
   - Each dump must include: timestamp, unique ID (artifact/request/job), input context, raw response, failure category

3. **Verify call path symmetry**
   - If a service has multiple call paths (e.g., `call()` vs `call_batch()`, sync vs async), verify each path has equivalent error handling and diagnostic coverage
   - Asymmetric error handling is a systematic blind spot — one path silently swallows errors while another correctly reports them

4. **Check for diagnostic bug propagation**
   - The same logging bug pattern often repeats across stages (nimbus B16 in vla_simulation → B19 same pattern in trajectory_filter)
   - When you find a logging bug in one stage, `grep` for the same pattern in all other stages

5. **Log audit**
   - For each stage, trace one failure path end-to-end through logs
   - Can you answer: "which input caused this failure, what was the raw response, and what category of failure was it?"
   - If you can't answer all three from logs alone → fix the logging first

#### Anti-pattern: "I'll add logging when I need it"

Every time you add logging reactively, you need another test cycle to collect the data. With N failure modes and M logging gaps, you burn N×M cycles instead of 1 upfront investment.

---

### 1.2 Failure Census (UNDERSTAND BEFORE FIXING)

**Before fixing anything, build a complete picture of what's failing and how often.**

> *Evidence*: nimbus EXP-028–030 spent 3 experiments fixing instantiation parse failures (11% of total), while type planning empty responses (67% of total) went unnoticed. EXP-031 Reflection: "Should have done a grep -c error frequency count first, would have located it in 30 seconds"

#### Steps

1. **Run the 5-minute error frequency check** on existing logs:
   ```bash
   # Count distinct error types
   grep -c "FAILED" pipeline.log
   grep -oP 'reason=\K[^,]+' pipeline.log | sort | uniq -c | sort -rn
   ```

2. **Run the system once** with full diagnostics enabled (from 1.1)

3. **Categorize every failure** by:
   - **Layer**: Which component/stage produced it?
   - **Type**: What kind of failure? (empty response, parse error, timeout, logic error, etc.)
   - **Frequency**: How many times did each type occur?

4. **Build a failure frequency table**:
   ```
   | Failure Type         | Layer    | Count | % of Total | Impact |
   |----------------------|----------|-------|------------|--------|
   | Empty API response   | Service  | 12    | 67%        | High   |
   | Think-only text      | Parsing  | 2     | 11%        | Medium |
   | Truncated JSON       | Parsing  | 1     | 6%         | Low    |
   ```

5. **Prioritize by frequency × impact**, not by which failure you noticed first

#### Anti-pattern: "Fix what I see first"

Your first observation is usually a symptom, not the highest-frequency root cause. The failure you notice first is the one with the most dramatic error message, not necessarily the most common one.

---

### 1.3 Campaign Plan

At the start of any multi-round debugging campaign, fill this out:

```markdown
## Debug Campaign: [System Name]

**Target metric**: [e.g., prompt_generation ≥ 6/7]
**Current baseline**: [e.g., 5/7]
**Verification method**: [e.g., smoke test with --batch-size 14, run twice]
**Planned cycles**: 3-5 (expect onion layers)

### Phase 0 Status
- [ ] All failure branches have structured logging
- [ ] All call paths have symmetric error handling
- [ ] Dump files include: timestamp, ID, input context, raw response, failure category
- [ ] Can trace any single failure end-to-end from logs
- [ ] Checked for same logging bug pattern across all stages

### Failure Census (updated after each cycle)
| Failure Type | Layer | Count | % | Status |
|---|---|---|---|---|
| ... | ... | ... | ... | Open / Fixed / Accepted |

### Fix Cycle Log
| Cycle | Target Failure | Hypothesis Type | Fix Applied | Result | New Failures Revealed |
|---|---|---|---|---|---|
| 1 | ... | direct/analogy | ... | ... | ... |
```

---

## Part 2: Investigation

### 2.1 Hypothesis Discipline

**Not all hypotheses are created equal. Track their provenance.**

> *Evidence*: In three independent events (orchard EXP-005 USD instancing, nimbus SCALE_FACTOR, cortex-self EXP-050 TiledCamera), analogy-based reasoning led to wrong root cause identification, each costing 6h+ or introducing destructive changes.

#### Two types of hypotheses

| Type | Source | Examples | Confidence |
|---|---|---|---|
| **Direct evidence** | Error message, stack trace, log entry, reproduction | "Log says `KeyError: 'choices'`" | High — can act on it |
| **Analogy-based** | Similar issue, code comment, intuition, pattern matching | "Similar GitHub issue suggests USD instancing" | Low — must falsify first |

#### The rule

1. **Classify your hypothesis**: Is it from direct evidence or analogy?
2. **Check known traps**: Does this hypothesis touch a pattern you've been burned by before? (Check project knowledge entries in knowledge/index.md)
3. **If analogy-based → design a <30min falsification experiment** before investing in a fix
   - Not "explore whether this hypothesis could be right" — design a test that would **disprove** it
   - If the experiment fails to disprove → upgrade to working hypothesis
   - If disproved → abandon immediately, don't sunk-cost deeper
4. **Label hypotheses explicitly** in your notes: `[hypothesis: direct]` vs `[hypothesis: analogy — needs falsification]`

#### Anti-pattern: "Similar issue exists, so that must be the cause"

Finding a similar-looking bug report or code comment is the **start** of an investigation, not the end. Three independent events proved that plausible-sounding analogies led to completely wrong root causes.

---

### 2.2 Evidence Trust Hierarchy

When evaluating information sources during debugging, weight them accordingly:

```
Level 1 (highest): Direct observation — error message, log, symptom reproduction
Level 2:           Official documentation + verified example code
Level 3:           GitHub issue with reproduction steps + user confirmation
Level 4:           Code comments with date and author context
Level 5:           Commented-out code with no explanation
Level 6 (lowest):  "I think I remember..." or unnamed conventions
```

> *Evidence*: orchard KNOWLEDGE.md §3.2 — code comments in `balanced.kit` ("DLSS frame gen does not yet support tiled camera well") pointed in the right direction but didn't explain the actual post-processing issue. Different interpretations led to different (wrong) debugging paths.

**Rule**: Information from Level 3-6 must be treated as hypotheses requiring falsification (see 2.1).

---

### 2.3 Cross-Component Value Tracing

**Before declaring a value "wrong", trace it through the entire pipeline.**

> *Evidence*: nimbus SCALE_FACTOR=0.01 was "fixed" to 1.0 because it looked like a bug. Actually it compensated for Isaac Sim's 100× USD magnification. The "fix" broke the pipeline.

**Rule**: When a value looks obviously wrong in one component, check:
1. What downstream component consumes this value?
2. Does the downstream component apply any transformation (scaling, offset, format conversion)?
3. Is this value compensating for a known behavior?
4. If you can't answer these questions → don't change the value; ask someone who knows

---

### 2.4 Reproduction Completeness

**Some bugs require N conditions simultaneously. Missing one = can't reproduce.**

> *Evidence*: orchard EXP-005 — TiledCamera DL denoiser bug required ALL THREE: (1) TiledCameraCfg (not CameraCfg), (2) 20+ environments, (3) different visual content per env. Missing any one condition = no visible symptom. 4 envs with same content showed nothing.

#### Progressive reproduction protocol

When a bug resists simple reproduction:

```
Step 1: Minimal scene (basic geometry + small scale)
Step 2: Add one dimension of complexity (more components)
Step 3: Add another dimension (scale up)
Step 4: Add content diversity
Step 5: Match production configuration exactly
```

Bug appears when you cross a step → that step's dimension is involved. Document **all** conditions required for reproduction — this prevents false "cannot reproduce" conclusions.

---

## Part 3: Fix Cycles

### 3.1 The Onion Layer Pattern

Multi-stage systems have bugs that layer: fixing one layer reveals the next.

```
Layer 1: Environment bugs        (PATH, service startup, container conflicts)
Layer 2: Crash-level bugs        (unhandled exceptions, resource exhaustion)
Layer 3: Protocol bugs           (wrong field names, missing parameters)
Layer 4: Logic bugs              (incorrect parsing, wrong code paths)
Layer 5: Robustness bugs         (intermittent failures, edge cases)
Layer 6: Quality/diagnostic bugs (wrong failure reasons, silent data corruption)
```

> *Evidence*: nimbus EXP-001→014 exposed 6 layers sequentially (environment → crash → exception handling → resource → service degradation → diagnostic quality). Same pattern re-emerged in EXP-024→027 (env dependencies → Docker conflicts → service fields → response content). Each 2-3x scale-up also reveals new layers.

**Plan for 3-5 fix cycles**, not 1. Each cycle typically moves you one layer deeper. If you're on fix cycle 6+, consider whether the architecture itself is the problem.

---

### 3.2 Prioritized Fixing

**Fix issues in frequency × impact order. Batch related fixes.**

#### Rules

1. **Start from the highest-frequency failure**
   - Fix the 67% problem before the 6% problem
   - If a single root cause explains multiple failure types, fix that root cause

2. **Batch related fixes into a single cycle**
   - If three diagnostic gaps are in the same code path, fix all three before re-running
   - But don't mix diagnostic fixes with behavior fixes — separate concerns

3. **Each fix cycle follows `systematic-debugging` Phase 1-4**
   - Root cause investigation → pattern analysis → hypothesis → implementation
   - Single hypothesis at a time within each cycle

4. **After each fix, re-run the failure census (Part 1.2)**
   - The distribution WILL change. New failures will emerge
   - Update your frequency table. Re-prioritize.

---

### 3.3 Hotfix Discipline

**Don't modify code while a test is running.**

> *Evidence*: nimbus EXP-006 — modified code mid-batch, then batch 2 ran with unverified fix. Created uncertainty: did the fix work, or did different inputs hide the problem?

**Rules**:
- Never change code during an active run — let it complete or kill it first
- Each run should correspond to exactly one known code state (ideally a git commit)
- If you need to fix something urgently, stop the current run, fix, commit, restart

---

## Part 4: Verification

### 4.1 Statistical Discipline

**Verify that your fix actually helped, with enough statistical power to be confident.**

Small samples make it impossible to distinguish signal from noise:

| Sample Size | Observed Rate | 95% Confidence Interval |
|-------------|---------------|------------------------|
| 7           | 71% (5/7)     | 29% – 96%             |
| 14          | 71% (10/14)   | 42% – 92%             |
| 30          | 73% (22/30)   | 54% – 88%             |
| 50          | 72% (36/50)   | 58% – 84%             |

#### Rules

1. **Minimum smoke test size**: At least 14 samples. Double if baseline variance is high.

2. **Run the same test at least twice**: Two consecutive identical results (e.g., 10/14 + 10/14) is stronger evidence than one 10/14.

3. **Track trends, not snapshots**: Maintain a history table of results across fix cycles. Look for directional trends.

4. **Distinguish "fix worked" from "metric improved"**:
   - The fix may correctly address one failure mode
   - But the metric may not improve because another failure mode dominates
   - This doesn't mean your fix was wrong — re-run the census

---

### 4.2 The Unit Test → Smoke Test Gap

**Unit tests mock external dependencies. They cannot catch real-system failures.**

> *Evidence*: This pattern repeated 4 independent times in nimbus:
> - EXP-021: 19/19 unit tests pass → EXP-022: 5/7 smoke test failures
> - EXP-026: 2 tests pass → EXP-027: 4/7 failures
> - EXP-030: 29 tests pass → EXP-033: 2/7 residual
> - EXP-032: 34 tests pass → EXP-033: still residual failures

**What mocks cannot catch**:
- Real service output format changes (e.g., `reasoning_content` vs `content`)
- Service-specific failure modes (think-only responses, truncated JSON)
- Service-layer silent failures (`response.success=False` bypassing stage-level logging)
- Resource contention and timing issues

**Correct workflow**: fix → unit test (regression protection) → smoke test (real-service verification) → write conclusions. Never skip the smoke test.

---

### 4.3 Progressive Scaling

**Test at increasing scales, not just minimum or maximum.**

> *Evidence*: nimbus EXP-006 jumped from 5 → 21 objects, wasting compute to discover GPU descriptor pool exhaustion (B9). orchard EXP-005 showed bugs that only appear at 20+ environments, invisible at 4.

```
Scale 1: Unit test (mocked, fast, catches regressions)
Scale 2: Smoke test (real service, small: 7-14 items)
Scale 3: Medium run (real service, 30-50 items)
Scale 4: Full production run
```

**Rules**:
- Each scale must pass before proceeding to the next
- GPU/resource bugs typically emerge at Scale 3
- Service degradation/fatigue bugs emerge at Scale 4 after extended runtime
- Never skip directly from Scale 1 to Scale 4

---

## Part 5: Campaign Management

### 5.1 When to Escalate to Human

Not all debugging can or should proceed autonomously. Escalate when:

| Signal | Why | Action |
|---|---|---|
| >2 hours on a single hypothesis without direct evidence | Likely anchored on wrong model | Ask human for domain insight |
| About to change a non-obvious numerical value | May be intentional compensation | Verify purpose with human first |
| Hypothesis is purely analogy-based and falsification experiment failed | Need domain expertise | Present findings, ask for direction |
| 3+ fix cycles without measurable progress | May be architectural problem | Discuss with human before cycle 4 |
| Debugging involves shared resources (GPU, services) | May affect other users | Confirm before taking action |

---

### 5.2 When to Re-Census

Re-run the failure census (Part 1.2) when:
- A fix cycle completed (success or failure)
- The observed failure distribution seems to have shifted
- A new symptom appeared that wasn't in the original census
- You've been working on the same failure type for 2+ cycles without progress

---

### 5.3 Campaign Closure

**Before declaring "done", verify against the original success criteria.**

#### Closure Checklist

1. **Does the metric meet the target?** (not "improved" — meets the actual numeric target)
2. **Is the improvement stable?** (at least 2 consecutive runs at or above target)
3. **Are there known remaining failure modes?** (document them; classify as fixable vs. inherent)
4. **Update knowledge artifacts**: failure modes, diagnostic infrastructure added, learned knowledge entries (knowledge/K-NNN.md), STATUS.md, experiment entries (experiments/EXP-NNN.md)

#### The "Another Layer" Decision

After each fix cycle:
- **Hit target?** → Close the campaign
- **Measurable progress but not enough?** → Continue, re-census first
- **No progress despite correct fix?** → New dominant failure mode emerged; re-census
- **5+ cycles without target?** → Is the target achievable with this architecture?

---

## Part 6: Domain-Specific Patterns

### 6.1 Service / API Debugging

When debugging systems that call external services (LLM APIs, inference servers, microservices):

**Capture raw responses first.** Before analyzing parsing logic, save the complete raw provider response on every failure path. The root cause is often in what the service returned, not in how you parsed it.

> *Evidence*: nimbus EXP-026 — root cause was service layer field selection (`reasoning_content` vs `content`), but 3 prior experiments debugged the stage/parsing layer because no raw response was captured.

**Service fatigue.** Long-running GPU services degrade over time: memory fragmentation, state corruption, resource leaks. If failures increase with runtime duration, implement periodic restarts or health checks.

> *Evidence*: nimbus EXP-011 — TRELLIS2 normal for batches 1-5, degraded 6-10, completely failed 11+. 7 hours continuous runtime.

**Transient vs. persistent failures.** Distinguish BEFORE adding retry logic:
- **Transient**: Empty responses, timeouts → Single retry with backoff
- **Persistent**: Wrong field names, missing capabilities → Fix code, no retry
- Retrying a persistent failure wastes time and quota

**Call path drift.** Services with `call()` (single) and `call_batch()` (batch) paths drift apart over time. When you find a bug in one path, immediately check the other for the same class of issue.

---

### 6.2 Rendering / GPU Debugging

When debugging rendering pipelines (Isaac Sim, game engines, visualization):

**Layer-by-layer isolation.** Rendering pipelines have multiple implicit post-processing layers. Each can independently introduce artifacts, and artifacts compound across layers.

```
Scene Construction → Ray Tracing → [DL Denoiser] → [DLSS/TAA] → [Cached RT] → Output
```

> *Evidence*: orchard EXP-004 (DLSS jitter) and EXP-005 (DL denoiser cross-tile bleeding) — both symptoms appeared in rendered output but root causes were in different post-processing layers.

**Debug protocol**:
1. Check rendering configuration files for enabled post-processing stages
2. Disable each post-processing stage independently
3. Identify which stage isolates the symptom
4. Only then investigate scene/camera configuration

**Multi-condition reproduction.** Rendering bugs often require N conditions simultaneously. Progressive reproduction protocol (see 2.4) is essential.

**GPU resource awareness.** Check `nvidia-smi` before and during runs. GPU descriptor pool exhaustion, memory fragmentation, and VRAM limits can cause symptoms that look like logic bugs.

---

### 6.3 Multi-Stage Pipeline Debugging

When debugging pipelines with sequential stages:

**Identify the real bottleneck stage.** The stage that shows failures in logs may not be the actual bottleneck — a failure upstream can cascade to appear as failures in multiple downstream stages.

**Per-stage pass rate tracking.** Maintain a history table of pass rates per stage across experiments. This reveals trends invisible in single-run snapshots.

```
| Experiment | Stage A | Stage B | Stage C | Stage D |
|------------|---------|---------|---------|---------|
| EXP-001    | 100%    | 80%     | 100%    | 68%     |
| EXP-010    | 100%    | 100%    | 92.9%   | 70%     |
| EXP-033    | 71.4%   | 100%    | 80%     | 89.6%   |
```

**Naming/configuration verification.** When comparing two runs or two model checkpoints, always create a configuration comparison table listing all dimensions that could differ. Checkpoint names can be misleading.

> *Evidence*: orchard EXP-002 — model5-1 vs model10 improvement was attributed to data scaling, but the actual change was modality (adding a depth channel). Names didn't encode the difference.

**Scaling reveals new bug layers.** Each 2-3x scale-up exposes new failure types (resource contention, service fatigue, edge cases). Scale gradually: 5 → 14 → 50 → production.

---

## Part 7: Anti-Pattern Summary

| Anti-Pattern | Cost | Instead |
|---|---|---|
| Build diagnostics reactively | 2-3x more fix cycles | Part 1.1: instrument everything upfront |
| Fix the first failure you see | Miss the dominant root cause | Part 1.2: census first, prioritize by frequency |
| Treat analogy as conclusion | 6h+ wasted on wrong hypothesis | Part 2.1: classify hypothesis, falsify analogies |
| Trust code comments as facts | Wrong debugging direction | Part 2.2: apply evidence trust hierarchy |
| Change "obviously wrong" values | Break intentional compensation | Part 2.3: trace value through full pipeline |
| Give up on reproduction too early | Miss multi-condition bugs | Part 2.4: progressive reproduction protocol |
| Expect one fix to close it | Surprised by onion layers | Part 3.1: plan for 3-5 cycles |
| Hotfix during a running test | Can't attribute results to code state | Part 3.3: stop, fix, commit, restart |
| Test with tiny samples (n=7) | Can't distinguish signal from noise | Part 4.1: minimum n=14, run twice |
| Unit test = verified | Misses real-service failures | Part 4.2: always run smoke test after unit tests |
| Skip from unit test to full scale | Waste compute on known-broken code | Part 4.3: scale gradually (7→14→50→full) |
| Debug solo for >2 hours on analogy | Anchoring on wrong mental model | Part 5.1: escalate to human |
| Same logging bug in one stage only | Same pattern exists in other stages | Part 1.1: check for diagnostic bug propagation |
| Compare without config table | Misattribute improvements to wrong variable | Part 6.3: always create config comparison table |

---

## Quick Decision Tree

```
Starting a debug task?
├── Single, clearly reproducible bug?
│   └── Use systematic-debugging directly
├── Multiple failures or intermittent?
│   ├── Have diagnostic coverage? (Part 1.1)
│   │   ├── No → INSTRUMENT FIRST
│   │   └── Yes → Have failure census? (Part 1.2)
│   │       ├── No → Run census, build frequency table
│   │       └── Yes → Fix highest-frequency issue (Part 3)
│   │           ├── Hypothesis from direct evidence? → Act on it
│   │           └── Hypothesis from analogy? → Falsify first (Part 2.1)
│   └── After fix: re-census (Part 5.2), check target (Part 5.3)
├── 3+ fix cycles without convergence?
│   └── Re-evaluate: wrong root cause, wrong hypothesis type, or architectural problem?
├── Can't reproduce?
│   └── Progressive reproduction protocol (Part 2.4)
└── Non-obvious value looks wrong?
    └── Trace full pipeline before changing (Part 2.3)
```
