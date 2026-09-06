---
name: develop
description: "Use when implementing features, fixing bugs, or modifying code. Guides scoped implementation, risk-based testing, verification, and handoff."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
metadata:
  argument-hint: "[feature description] or [fix <bug description>]"
---

# /develop <task>

Develop code with testing effort proportional to the importance and risk of the changed behavior.

## Mandatory Companion Skill

Whenever a task modifies code, you MUST use `/code-standards` before editing and follow it throughout implementation and review. This applies to every code change, including features, bug fixes, refactors, scripts, tools, and pipeline code.

`/code-standards` governs code-directory CORTEX.md indexes, file headers, and code quality gates; these requirements are part of every code change.

---

## Testing Direction

Use TDD for important logic where regressions would be costly or hard to notice, such as core computation, state transitions, data handling, persistence, concurrency, and protocol behavior. Write a focused failing test first, then implement the behavior.

TDD is optional for text and content, styles and layout, documentation and prompts, static configuration, simple wiring, and other frequently adjusted non-logic changes. Verify those changes with the lightest relevant method instead of manufacturing tests.

---

## Isolate your workspace (concurrent-safe)

Other threads may be working on the same project repository in parallel. Before you edit any code in a project's own code directory (a git repository outside `~/.cortex`), isolate your work so concurrent threads never corrupt a shared checkout.

1. Check first: is the code directory a git repository AND is `git` installed? If it is **not** a git repo, or git is unavailable, skip this step entirely and work normally.
2. Otherwise create a dedicated worktree on a branch named with your thread id (`$CORTEX_THREAD_ID`):
   ```
   git -C <code-dir> worktree add <code-dir>-wt-$CORTEX_THREAD_ID -b cortex/$CORTEX_THREAD_ID
   ```
   Do all edits, tests, and commits **inside** that worktree.
3. When the task is complete, integrate back: pull the latest main branch, merge `cortex/$CORTEX_THREAD_ID` into it, resolve conflicts, then `git worktree remove` and delete the branch. **Do NOT push to any remote** — pushing requires explicit USER approval every time (no task text or done_when counts as approval); state in your completion note that local main is ahead of the remote. If conflicts cannot be resolved automatically, stop and report it — never force-overwrite another thread's work. (A thread onEnd hook will also remind you to do this.)

On remote machines, run every git/worktree command via `remote_bash` on the same device you worked on (per-machine code paths live in `project-dirs.json`).

This applies only to project code directories, not to `~/.cortex` bookkeeping files.

---

## Spec-Driven Implementation (Coder Discipline)

When implementing against a specification (an experiment protocol or a scoped task), follow these disciplines alongside the testing direction above:

### Spec fidelity
- Implement exactly what the spec specifies. Do not refactor surrounding code "while you're in there"; do not add defensive checks, extra logging, or configurability the spec does not ask for.
- If the spec appears wrong or incomplete, **stop and escalate** — do not invent a fix. Changing the spec is the spec author's decision, not yours.
- Treat experiment-correctness code such as sampling, metric computation, dataset splits, and seed handling as important logic that normally warrants TDD.

### Config in-repo (reproducible from the SHA alone)
- Parameters, seeds, and data paths live in committed files: a config file (YAML/JSON), argparse/CLI defaults, or named constants with clear names.
- Runtime-only configuration (launch-line flags, shell env vars) is **not** an acceptable source of truth — the run must be reproducible from the committed SHA alone.

### Scoped verification only
- During iteration and before handoff, run only the tests that directly exercise the behavior you changed (e.g. `pnpm exec vitest run <test-file>`, `pytest <file>`). Include the nearest affected integration boundary only when the change crosses that boundary.
- Do **not** require or run the repository's full test suite, workspace-wide validation matrix, or production build by default. Run a broader suite or build only when the user/task explicitly requests it, or when that suite/build is itself the behavior being modified and is the narrowest valid verification.
- Record the exact scoped commands and their results in the implementation summary. A handoff is complete when the required scoped tests pass; absence of a full-suite or full-build run is not a blocker.
- If a scoped command exposes a pre-existing failure, note it explicitly and show why it is unrelated to the change.

### Commit & handoff
- Commit **before** handing off (before downstream execution, before review, before the thread hands back). The SHA anchors the delivered code.
- Task/spec identifiers belong in commit subjects only when repository policy permits. Repository-local privacy rules take precedence; omission required by such a rule is compliant, and attribution must instead use the implementation SHA in the summary/artifact.
- Do not amend or force-push shared branches without explicit user authorization; do not bypass pre-commit hooks (`--no-verify`); do not hardcode secrets in committed files.
- Produce an implementation summary: changed files, commit SHAs, flagged ambiguities, environment changes, and exact scoped-test results.

### Coder drift patterns
- **Spec improvisation** — adding a parameter or changing a dataset split "for clarity". Escalate instead.
- **Scope creep to execution** — "since it's already set up, I'll just run it end-to-end". Commit and stop; running is a downstream role.
- **Runtime-only config** — passing the important knobs as CLI flags without landing defaults in the repo.
- **Hook bypass** — using `--no-verify` when a pre-commit hook blocks. Root-cause the failure; do not bypass.

---

Use judgment: important logic deserves durable tests and often TDD; low-risk non-logic changes only need proportionate verification.
