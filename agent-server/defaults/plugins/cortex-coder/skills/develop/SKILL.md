---
name: develop
description: "ALWAYS use this skill when implementing new features, fixing bugs, or modifying code in the Cortex codebase. Enforces test-driven development discipline: write tests first, then implement, then verify. Covers agent-server code, training scripts, data pipelines, and any code that will run unattended. Do NOT skip this skill and write code directly."
allowed-tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Bash
argument-hint: "[feature description] or [fix <bug description>]"
---

# /develop <task>

Develop code using test-driven development. Covers new features and bug fixes for any code in the Cortex project (agent-server, scripts, tools, pipeline code).

The argument determines the mode:

| Argument pattern | Mode | Example |
|---|---|---|
| `fix <description>` | Bugfix | `/develop fix task parser crashes on empty TASKS.md` |
| Anything else | Feature | `/develop add experiment cost tracking` |

---

## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Wrote code before writing a test? Delete the code. Write the test. Watch it fail. Then reimplement.

- Do not keep the deleted code as "reference"
- Do not "adapt" it while writing tests
- Delete means delete — start fresh from what the test demands

**Violating the letter of this rule is violating the spirit.**

---

## What to Test — and What Not To

TDD mandates a failing test first; this section governs which tests are worth writing at all. A test earns its place by being able to fail on a real bug: **if you cannot name the bug that would make it fail, do not write it.**

Test these (behavior the suite must own):
- Behavior contracts at module boundaries: inputs → outputs/effects.
- State machines and lifecycle transitions, including illegal-transition rejections.
- Persistence and concurrency: atomic writes, mutex serialization, recovery paths.
- Protocol/format translation: adapter normalization, parsers, serializers.
- Error paths that guard real regressions.
- Anything that runs unattended.

Do NOT write:
- Assertions restating constants or config literals back at themselves. If the shape is the contract, collapse to one whole-object equality.
- Verbatim help/usage text matching — test routing and exit codes instead.
- Tests of a test double's trivial surface, or of third-party library behavior.
- Higher-layer re-assertions of values a lower layer already pins (a view re-asserting vm output; a CLI re-proving the mutator's semantics). The higher layer tests only what it adds: argv parsing, exit codes, routing, render slots — plus ONE thin wiring round-trip.
- Local re-implementations of production logic asserted against themselves — such tests cannot fail.

Placement and cost discipline:
- One behavior, one test, at the lowest layer that owns the logic.
- Extend the module's existing test file; a new file is for a new module.
- Prefer fake timers or bounded polls on observable state over fixed real sleeps; never bind fixed ports; a per-test mkdtemp is fine, but do not spawn subprocesses or listeners when a direct call exercises the same contract.

---

## Mode: Feature

### Step 1: Understand

1. Read the relevant source files.
2. Check `context/decisions/` for constraints on the area you're changing.
3. Search for existing patterns — functions, types, utilities — that can be reused. Do not build what already exists.
4. If the scope is large (>3 files, architectural change), use `/solution-design` to plan first.
5. If the feature involves CLI design (new subcommand, new CLI tool, CLI flag changes), read `/cli-standards` for the 7 mandatory rules.

### Step 2: Write tests

1. Identify or create the test file — colocated near the source file, or in a `tests/` directory.
2. Write failing tests that describe the expected behavior. Cover:
   - Happy path (the feature works as intended)
   - Edge cases (empty inputs, missing data, error conditions)
   - Integration points (does it interact correctly with adjacent components?)
3. Run tests to confirm they fail.

### Step 3: Implement

1. Write the minimum code to make tests pass.
2. Follow existing patterns in the codebase (naming, error handling, types).
3. Keep files under reasonable length. Extract modules if needed.
4. Run tests after each significant change.

### Step 4: Verify

1. All tests pass.
2. No unintended side effects — review your diff with `git diff`.
3. If touching Python: check types/lint if tools are available.

### Step 5: Document

1. If the change is non-trivial, add a note to the relevant STATUS.md.
2. If a design decision was made, check whether a Decision Record is warranted.
3. If you modified a convention or rule that appears in multiple documents, propagate the change.

---

## Mode: Bugfix

### Step 1: Reproduce

1. Read the bug description and identify the symptom.
2. Trace the code path — read the relevant source files, follow the execution flow.
3. Identify the root cause.
4. Check logs or error output if available.

### Step 2: Write regression test

1. Write a test that reproduces the bug.
2. The test should fail with the current code (confirming the bug exists).
3. Run tests — the new test should fail, others should pass.

### Step 3: Fix

1. Apply the minimum change to fix the root cause.
2. Run tests — all tests should now pass.

### Step 4: Verify

1. All tests pass.
2. Review diff — confirm the fix is targeted and doesn't introduce new issues.
3. If the bug was in a hot path, consider whether adjacent code has the same pattern.

---

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "Too simple to need a test" | Simple code breaks. The test takes 30 seconds to write. |
| "I'll add tests after implementing" | Tests that pass immediately prove nothing — you never saw them catch the bug. |
| "I already tested it manually" | Manual testing is ad-hoc. No record, can't re-run, easy to miss cases. |
| "The fix is obvious, just one line" | One-line fixes cause regressions. The regression test takes 2 minutes. |
| "This is just a config change" | Config changes that affect behavior need tests. If it can break, test it. |
| "I'm almost done, adding tests now would slow me down" | Sunk cost fallacy. Tests now prevent debugging later. |
| "Keep the code as reference, then write tests" | You'll adapt it instead of starting fresh. That's testing after, not TDD. |
| "The existing code has no tests, why start now?" | You're improving the codebase. Add tests for what you touch. |
| "This is infrastructure, not business logic" | Infrastructure bugs take down everything. Test it more, not less. |
| "I need to explore the approach first" | Fine — prototype, then delete it and start with TDD. Exploration is not implementation. |
| "The user is waiting / this is urgent" | Urgency makes regression tests MORE important, not less. The next occurrence won't have a user watching to verify. Write the test first — it takes 2 minutes. |

---

## Red Flags — STOP and Reassess

If you notice any of these, stop and return to Step 2 (Write tests):

- Writing implementation code before any test exists
- A test passes immediately without any implementation change
- Rationalizing "just this once" or "this case is different"
- Expressing confidence about correctness without running tests
- Wanting to commit before all tests pass
- Three or more fix attempts on the same bug — this signals an architectural problem, not a simple bug. Stop fixing and investigate the design.
- Claiming "tests after achieve the same goals" — tests-after verify what you built; tests-first verify what's required. They are not equivalent.

---

## Verification Gate

Before claiming any task is complete:

1. **Run tests**: See the output, count failures — zero expected
2. **Review diff**: `git diff` — confirm changes are targeted and complete
3. **Only then** claim the work is done

Never use "should work", "probably passes", or "looks correct". Evidence before claims.

---

## Spec-Driven Implementation (Coder Discipline)

When implementing against a specification (an experiment protocol or a scoped task), the TDD flow above is wrapped by these disciplines:

### Spec fidelity
- Implement exactly what the spec specifies. Do not refactor surrounding code "while you're in there"; do not add defensive checks, extra logging, or configurability the spec does not ask for.
- If the spec appears wrong or incomplete, **stop and escalate** — do not invent a fix. Changing the spec is the spec author's decision, not yours.
- Experiment-correctness code (sampling, metric computation, dataset splits, seed handling) **requires** a test regardless of size.

### Config in-repo (reproducible from the SHA alone)
- Parameters, seeds, and data paths live in committed files: a config file (YAML/JSON), argparse/CLI defaults, or named constants with clear names.
- Runtime-only configuration (launch-line flags, shell env vars) is **not** an acceptable source of truth — the run must be reproducible from the committed SHA alone.

### Scoped tests while iterating, full suite once before handoff
- While iterating, run only the tests scoped to what you changed (e.g. `pnpm exec vitest run <test-file>`, `pytest <file>`) — do NOT run the full suite on every edit-test cycle. Full-suite runs are expensive and machine-wide serialized; frequency is what overloads the box.
- After the final commit, run the full suite ONCE with the project's own command (`npm test`, `pytest`, `make test`, …), covering **every** configured stage — unit tests, linters or architecture checks, integration tests, regression suites. A single red test or lint violation means you are not done.
- Record the green SHA (the commit the full suite passed on) plus the pass counts in your implementation summary. A downstream reviewer at the same SHA may verify against this record instead of re-running the full suite; if you change anything after the green run, the full suite must be re-run.
- If failures pre-existed your change, note them explicitly in the summary; you must still confirm no NEW failures were introduced.

### Commit & handoff
- Commit **before** handing off (before downstream execution, before review, before the thread hands back). The SHA anchors the delivered code.
- Task/spec identifiers belong in commit subjects only when repository policy permits. Repository-local privacy rules take precedence; omission required by such a rule is compliant, and attribution must instead use the implementation SHA in the summary/artifact.
- Do not amend or force-push shared branches without explicit user authorization; do not bypass pre-commit hooks (`--no-verify`); do not hardcode secrets in committed files.
- Produce an implementation summary: changed files, commit SHAs, flagged ambiguities, environment changes, and test-suite pass/fail status.

### Coder drift patterns
- **Spec improvisation** — adding a parameter or changing a dataset split "for clarity". Escalate instead.
- **Scope creep to execution** — "since it's already set up, I'll just run it end-to-end". Commit and stop; running is a downstream role.
- **Runtime-only config** — passing the important knobs as CLI flags without landing defaults in the repo.
- **Hook bypass** — using `--no-verify` when a pre-commit hook blocks. Root-cause the failure; do not bypass.

---

## When TDD Does Not Apply

TDD is mandatory for code changes. It does NOT apply to:

- Pure documentation changes (CORTEX.md, STATUS.md, experiment files)
- Configuration value changes with no code path (e.g., changing a budget number)
- Prompt text changes in skills (SKILL.md files)
- Data analysis scripts that produce one-time reports (though reusable analysis tools should be tested)

When in doubt: if the change could introduce a regression, it needs a test.
