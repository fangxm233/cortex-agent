---
name: execute-method
description: "Use when producing or updating a document under a project (status updates, digests, decision records, reports, knowledge entries, scoping memos), OR when executing any scoped actionable task (code changes, file edits, config updates, script runs, data processing). Trigger whenever Doc Writer is about to produce a document deliverable, or Executor is about to carry out a scoped work item. Covers the read → produce → index → summarize discipline for both modes."
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# /execute-method — Production & Execution Methodology

The disciplined procedure for producing a deliverable and leaving the project in a consistent, auditable state. Two modes share the same skeleton (restate → read inputs → do the work → verify/cite → update index → summarize); pick the mode that matches your role.

Cortex optimizes **Quality > Cost > Speed**. Correctness, provenance, and scope fidelity come first; editing the canonical file beats forking a parallel one; speed is residual.

---

## Mode A — Document production (Doc Writer)

Use this mode when the deliverable is a readable file (status update, digest, decision record, report, knowledge entry, scoping memo).

1. **Restate the task** in your own words. Confirm you understand the deliverable, the target file(s), and the sources you will cite. If the task isn't crisp, restate the goal before writing.
2. **Read all required inputs** before writing a single line — the task description, the project's `STATUS.md` / `mission.md` / `roadmap.md`, the CORTEX.md / index of the directory you are about to modify, and any upstream sources the document consumes.
3. **Choose the target file(s).** Prefer editing the existing canonical file; create a new file only if the task clearly requires a new artifact. Never create `STATUS-new.md` / `decision-draft.md` parallel forks.
4. **Write the content. Cite as you go** — do not claim "I'll cite later". Every non-trivial factual claim carries a source (`file_path:line_number`, `DR-NNNN`, a knowledge/experiment/pattern ID, a commit SHA, or inline arithmetic). If a field cannot be confirmed, mark it `??` and explain — never fabricate.
5. **Update the relevant index / CORTEX.md.** A new file in a directory that has a `CORTEX.md` index is incomplete until its index entry exists. (Auto-generated indexes such as `experiments/index.md`, `knowledge/index.md`, `patterns/index.md` are rebuilt by `memory-index-regen.ts`, not hand-edited.)
6. **Append `## Write Summary (iteration N)`** to the thread artifact, listing: each file modified (one-line summary), sources cited (so the reviewer can audit them), any ambiguity you resolved with an assumption (so the reviewer can challenge it), and any TODO you intentionally left. Do **not** write `[APPROVED]` — that belongs to Doc Reviewer.

## Mode B — Task execution (Executor)

Use this mode when the deliverable is actioned work (code changes, file edits, config updates, script runs, data processing).

1. **Restate the task** in your own words. Confirm you understand what "done" means. If the task is vague to the point you cannot determine "done", stop and report the gap.
2. **Read all files you intend to modify** before making changes, plus the project's current state (`STATUS.md` / `mission.md` / `roadmap.md` if they exist) and any upstream sources the task references.
3. **Execute the task** — make the changes, run the commands. Stay in scope: no bonus refactors, no "while I'm here" edits. For destructive operations, verify safety first.
4. **Verify the result** — check file syntax, command exit codes, and basic correctness. Modified files must be well-formed and pass basic sanity checks.
5. **Update any relevant index / CORTEX.md** for new files (same auto-generated-index caveat as Mode A).
6. **Append `## Execute Summary (iteration N)`** to the thread artifact, listing: each file modified (one-line summary), each command run (with exit code), key decisions and rationale, any ambiguity you resolved with an assumption, and any TODO you intentionally left. Do **not** write `[APPROVED]` — that belongs to Executor Reviewer.

---

## Discipline that governs both modes

- **Stay in scope.** Produce only what the task asked for. No extra sections, decisions, features, or commentary that wasn't requested.
- **Edit, don't fork.** If there is a canonical file, update it in place.
- **Provenance / no fabrication.** No invented citations, identifiers, numbers, names, or URLs you did not retrieve. When paraphrasing a source, preserve its meaning — do not soften or drift.
- **Indexes are part of the deliverable.** A new file without its index entry is incomplete.
- **Record assumptions.** If the task is ambiguous and you must resolve it, document the resolution so the reviewer can challenge it.
- **No unmarked half-done work.** Do not leave `TODO` / `TBD` placeholders where the task required a value, unless the task explicitly authorized them.
- **The summary is the handoff.** The reviewer audits against your `## Write Summary` / `## Execute Summary`; an accurate, complete summary is what makes the review possible.
