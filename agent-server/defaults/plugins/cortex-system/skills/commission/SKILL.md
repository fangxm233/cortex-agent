---
name: commission
description: "Use when the user asks to run something as a commission (委托/长任务) — a contract-anchored long task — including starting one (drill alignment → contract → approval) or working inside a session already bound to a commission (checkpoint discipline). Trigger phrases: commission 模式, 长任务, 委托, drill me on this task."
author: Cortex
version: 1.0.0
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - mcp__cortex-core__cortex_context
  - mcp__cortex-core__cortex_ask_user
  - mcp__cortex-core__cortex_commission_plan_exit
  - mcp__cortex-core__send_decision
---

# Commission Mode

A commission is a long task anchored by two files the user can always read:

- `contract.md` — the binding intent reference. Written once via drill, changed only by appending to 修订记录. The user may edit it at any time.
- `ledger.md` — your state self-report, the single source of truth for progress. You maintain it; completion claims need evidence pointers.

Layout under the project context directory (the [Session Project] block gives you the path):

```
commissions/<slug>/
  contract.md     # intent reference
  ledger.md       # state ledger
  assets/         # rich content you generate (images, .html — rendered sandboxed)
  decisions.jsonl # server-side projection of send_decision — NEVER write this file
```

Two situations. If this session already has a [Commission] block in context, skip to Phase B. Otherwise the user is starting a new commission: run Phase A.

## Phase A — Initiation: drill → contract → approval

### A1. Create the draft directory

Get your session name from `cortex_context` (e.g. `cortex-a1b2`), then create
`<project context dir>/commissions/_draft-<session name>/`. The contract iterates in there.
The draft is not registered anywhere; if abandoned it is just a directory.

Do not implement anything in this phase. Investigation is read-only; the only thing you write is the contract draft.

### A2. Drill protocol

The goal is to surface and resolve the decisions hiding inside the user's request, before any work starts. Rules:

**Codebase/context-first.** Never ask what you can look up. Before the first question, explore the repo / project context enough to know what actually exists. Use findings to ask sharper questions ("X currently does A — should the new path replace it or sit beside it?"), and to challenge premises when the code contradicts the request.

**Depth-first tree traversal.** Map the top-level decision branches (components, risky choices, unknowns). Pick ONE branch and drill it to resolution — or to the user explicitly deferring it — then backtrack to the next branch. Do not scatter questions across branches in one batch.

**Question format.** Ask via `cortex_ask_user`. Every question carries concrete options, your recommendation marked as such, and a "你定" (you decide) escape that means "go with the recommendation". Later questions may depend on earlier answers — that is why batches stay small: at most 4 questions per call, usually 1-2, all from the branch currently being drilled.

**Status summary.** Every 5–8 exchanges, post a summary in chat: Resolved so far / Open branches / Currently drilling. This keeps the user oriented and catches drift early.

**No premature agreement.** If an answer conflicts with an earlier answer or with repo reality, say so and re-ask. Do not smooth it over.

**Termination.** Stop when every branch is resolved or explicitly deferred, or the user says enough. Deferred branches go into the contract as 不做 items or as 闸门 (gates), never silently dropped.

### A3. Write contract.md

In the draft directory. Sections, in order:

```markdown
# 合约: <title>

## 目标（用户原话）
Quote the user's request verbatim. Do not paraphrase.

## 推断
What you filled in beyond the user's words. Each line tagged with its basis:
（用户答复：…）for drill answers, （repo 事实：path:line）for code findings.

## 验收条件
A-1, A-2, … — testable, each checkable by a command, a file, or a user look.

## 不做
Explicit exclusions and deferred branches, with one-line reasons.

## 闸门
The few points where execution MUST block on user confirmation (e.g. before
touching shared state, before an irreversible step). Keep this list short.

## 修订记录
（追加式，初始为空）
```

### A4. Submit for approval

Call `cortex_commission_plan_exit` with `contract_file_path` (the draft contract.md), `name` (the final commission name — must contain ASCII letters/digits, it becomes the directory slug), optional `title` and `summary`. The call blocks until the user decides.

- **Denied**: the feedback is in the result. Revise the contract in the draft dir and call again. The directory stays a draft.
- **Approved**: the server renames the draft to `commissions/<slug>/`, registers the commission, and binds this session. The result reports the final directory — the draft path is gone, use the new one from here on.

### A5. Initialize ledger.md

In the final directory, derived from the contract:

```markdown
# 账本: <title>

状态：<one line, overwritten each update>

## 计划
P-1 … — derived from 验收条件. Each item: status (todo/doing/done/cut/deferred).
缩小/推迟：mandatory note whenever an item is cut or deferred — what was dropped and why.

## 检查点
（CP-N entries, appended — see Phase B）

## 记录
（L-NNN entries, appended — see Phase B）
```

Then start executing, under Phase B discipline.

## Phase B — Execution: checkpoint discipline

The [Commission] block carries snapshots; the files on disk are authoritative. The user may have edited contract.md since the snapshot — re-read it at every checkpoint, including 修订记录.

**Surprise triage.** Everything unexpected is one of three kinds:
- an **obstacle** — route around it yourself, note it in a ledger L-entry;
- a **fork** — a real choice: low-stakes → pick and record via `send_decision`; high-stakes → blocking question via `cortex_ask_user`;
- a **discovery** — something that invalidates a contract premise. This MUST be surfaced against the contract (tell the user, and on their confirmation append to 修订记录). Never silently absorbed.

**Ledger entries (L-NNN).** Append for meaningful progress and obstacles. Any completion claim carries an evidence pointer: file path(:line), command + output location, EXP/K id. No pointer, no claim. Rich content (plots, reports) goes into `assets/` and is referenced by relative path from ledger.md. Never write `decisions.jsonl` — the server projects it.

**Checkpoints (CP-N).** At each stage boundary and ALWAYS before the session ends. A checkpoint is three diffs, each graded ok / attention / gate:

```markdown
### CP-3 (2026-08-28 session cortex-a1b2)
- 计划 vs 完成: … [ok]
- 合约 vs 当前方向: … [attention: …]
- 假设 vs 现实: … [ok]
```

Re-read contract.md (with 修订记录) immediately before writing a CP. Any diff graded `gate` means stop and ask the user before continuing. Update the 状态 line and 计划 item statuses in the same pass. When the checkpoint section grows long, compact old CPs to one line each — keep the latest 2-3 in full.

**Gates.** The contract's 闸门 items are blocking: ask via `cortex_ask_user` and wait. A streak of approvals never downgrades a gate to a notification.

**Completion.** You do not close a commission. When all 验收条件 pass, write a final CP with the evidence, set 状态 to 待验收, and tell the user — closing (完成/放弃) happens in the UI.
