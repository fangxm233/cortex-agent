---
name: commission
description: "How to work inside a commission — a contract-anchored long task. Loaded whenever this session is in commission mode. Covers maintenance: ledger entries, surprise triage, checkpoint discipline, gates. Creating a commission is not covered here — that protocol lives in the cortex_commission_start tool."
author: Cortex
version: 3.0.0
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - mcp__cortex-core__cortex_context
  - mcp__cortex-core__cortex_ask_user
  - mcp__cortex-core__send_decision
---

# Working inside a commission

A commission is a long task anchored by two files the user can always read:

- `contract.md` — the binding intent reference. Written once when the commission was created, changed only by appending to 修订记录. The user may edit it at any time.
- `ledger.md` — your state self-report, the single source of truth for progress. You maintain it; completion claims need evidence pointers.

Layout under the project context directory (the [Commission] block gives you the path):

```
commissions/<slug>/
  contract.md     # intent reference
  ledger.md       # state ledger
  assets/         # rich content you generate (images, .html — rendered sandboxed)
  decisions.jsonl # server-side projection of send_decision — NEVER write this file
```

The [Commission] block is only an index — it names contract.md and ledger.md, it does not carry their contents. Read both at the start of the session, and re-read contract.md (including 修订记录) at every checkpoint; the user may have edited it.

If this session is creating a new commission rather than continuing one, do not use this skill for that — call `cortex_commission_start`, which carries the whole creation protocol. Come back here once the contract has landed.

## Surprise triage

Everything unexpected is one of three kinds:

- an **obstacle** — route around it yourself, note it in a ledger L-entry;
- a **fork** — a real choice: low-stakes → pick and record via `send_decision`; high-stakes → blocking question via `cortex_ask_user`;
- a **discovery** — something that invalidates a contract premise. This MUST be surfaced against the contract (tell the user, and on their confirmation append to 修订记录). Never silently absorbed.

## Ledger entries (L-NNN)

Append for meaningful progress and obstacles. Any completion claim carries an evidence pointer: file path(:line), command + output location, EXP/K id. No pointer, no claim. Rich content (plots, reports) goes into `assets/` and is referenced by relative path from ledger.md. Never write `decisions.jsonl` — the server projects it.

## Checkpoints (CP-N)

At each stage boundary and ALWAYS before the session ends. A checkpoint is three diffs, each graded ok / attention / gate:

```markdown
### CP-3 (2026-08-28 session cortex-a1b2)
- 计划 vs 完成: … [ok]
- 合约 vs 当前方向: … [attention: …]
- 假设 vs 现实: … [ok]
```

Re-read contract.md (with 修订记录) immediately before writing a CP. Any diff graded `gate` means stop and ask the user before continuing. Update the 状态 line and 计划 item statuses in the same pass. When the checkpoint section grows long, compact old CPs to one line each — keep the latest 2-3 in full.

## Gates

The contract's 闸门 items are blocking: ask via `cortex_ask_user` and wait. A streak of approvals never downgrades a gate to a notification.

## Completion

You do not close a commission. When all 验收条件 pass, write a final CP with the evidence, set 状态 to 待验收, and tell the user — closing (完成/放弃) happens in the UI.
