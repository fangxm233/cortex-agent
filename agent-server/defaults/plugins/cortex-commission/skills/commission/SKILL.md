---
name: commission
description: "How to work inside a commission — a contract-anchored long task. Loaded whenever this session is in commission mode. Covers maintenance: ledger entries, surprise triage, checkpoint discipline, gates. Creating a commission is not covered here — that protocol lives in the cortex_commission_start tool."
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, mcp__cortex-core__cortex_context, mcp__cortex-core__cortex_ask_user, mcp__cortex-core__send_decision
metadata:
  author: "Cortex"
  version: "3.1.0"
---

# Working inside a commission

A commission is a long task anchored by two files the user can always read:

- `contract.md` — the binding intent reference. Written once when the commission was created, changed only by appending to its Revisions section. The user may edit it at any time.
- `ledger.md` — your state self-report, the single source of truth for progress. You maintain it; completion claims need evidence pointers.

Layout under the project context directory (the [Commission] block gives you the path):

```
commissions/<slug>/
  contract.md     # intent reference
  ledger.md       # state ledger
  assets/         # rich content you generate (images, .html — rendered sandboxed)
  decisions.jsonl # server-side projection of send_decision — NEVER write this file
```

The [Commission] block is only an index — it names contract.md and ledger.md, it does not carry their contents. Read both at the start of the session, and re-read contract.md (including its Revisions section) at every checkpoint; the user may have edited it.

If this session is creating a new commission rather than continuing one, do not use this skill for that — call `cortex_commission_start`, which carries the whole creation protocol. Come back here once the contract has landed.

## Surprise triage

Everything unexpected is one of three kinds:

- an **obstacle** — route around it yourself, note it in a ledger L-entry;
- a **fork** — a real choice: low-stakes → pick and record via `send_decision`; high-stakes → blocking question via `cortex_ask_user`;
- a **discovery** — something that invalidates a contract premise. This MUST be surfaced against the contract (tell the user, and on their confirmation append to Revisions). Never silently absorbed.

## Ledger entries (L-NNN)

Append to the Log section for meaningful progress and obstacles. Any completion claim carries an evidence pointer: file path(:line), command + output location, EXP/K id. No pointer, no claim. Rich content (plots, reports) goes into `assets/` and is referenced by relative path from ledger.md. Never write `decisions.jsonl` — the server projects it.

## Checkpoints (CP-N)

At each stage boundary and ALWAYS before the session ends. A checkpoint is three diffs, each graded ok / attention / gate:

```markdown
### CP-3 (2026-08-28 session cortex-a1b2)
- Plan vs done: … [ok]
- Contract vs direction: … [attention: …]
- Assumptions vs reality: … [ok]
```

Re-read contract.md (with its Revisions section) immediately before writing a CP. Any diff graded `gate` means stop and ask the user before continuing. Update the Status line and Plan item statuses in the same pass. When the Checkpoints section grows long, compact old CPs to one line each — keep the latest 2-3 in full.

## Gates

The contract's Gates items are blocking: ask via `cortex_ask_user` and wait. A streak of approvals never downgrades a gate to a notification.

## Completion

You do not close a commission. When all acceptance criteria pass, write a final CP with the evidence, set Status to "awaiting acceptance", and tell the user — closing (done / abandoned) happens in the UI.
