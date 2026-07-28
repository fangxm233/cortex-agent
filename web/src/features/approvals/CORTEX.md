# features/approvals/ — approval center overlay (7a)

Stage-R3. The **approval center** overlay — a centered 1120×700 modal
reproduced **1:1** from `design/ref/prototype.dc.html` L1317-1405 (+ shared backdrop L1292), diffed vs
`design/proto-shots/03-approval-center.png` (and the deny-armed footer vs `20-approval-deny-armed.png`,
which is the *inline card* deny state — the overlay's own deny-armed follows the source `apd.armed`
branch: feedback input + Cancel + Confirm reject). Wired to the **real** `approvals.*` ui-service scope
(paired backend scope): `approvals.list` for the queue, `approvals.approve` / `approvals.reject`
for a decision that flips the target entry's Status line in `~/.cortex/context/PENDING_APPROVALS.md`
(the mutate never runs the underlying operation) → the list re-invalidates for a live refresh.

| path | role |
|---|---|
| `approval-center-vm.ts` | **Pure** VM (TDD): `statusPill(status)` (amber/green/red), `pendingLabel(n)` (singular/plural), `toListCard` / `toDetail` (real ApprovalInfo → the prototype slots, incl. `origin`=`provenance` + `task`=`taskRef` real-when-present, missing fields → `—`/omit, `hasCommand` gate), `defaultSelectedId`. Framework-free. |
| `approval-center-vm.test.ts` | Unit tests for selection, field omission, provenance, command gating, and status semantics. |
| `ApprovalCenterModal.tsx` | The **1:1 overlay**. Its internal presentational view renders the backdrop + panel + queue + detail + decision footer; the container binds `approvals.list({status:'pending'})`, selection + armed/feedback state, `approvals.approve`/`approvals.reject` mutations (invalidate + toast), and Escape-close. `data-approval-center` / `data-approval-id` / `data-approval-feedback` / `data-action="arm\|cancel\|approve\|reject"` remain the E2E contract. |
| `ApprovalsProvider.tsx` | Global mount + `useApprovals()` context (`open()`/`close()`). One modal instance opened from the left-rail approval banner and mounted in `shell/AppShell`. |

## Triggers

- `features/workbench/LeftRail` — the "N approval pending" banner now uses the real
  `approvals.list({status:'pending'})` count and calls `useApprovals().open()` (was GAP-1, hidden).
## Data gaps (real ApprovalInfo vs the prototype mock) — flagged, never fabricated

The real `ApprovalInfo` (parsed from PENDING_APPROVALS.md) has
`{id,title,operation,reason,impact,command,status,queuedAt,decidedAt,feedback,provenance,taskRef}`.
§12 C item 13 verified the origin/task/ttl slots against BOTH writers (need-approval skill +
approval-gate `buildApprovalEntry`) and the live queue — neither emits a structured origin/from/task/ttl
field. The real source of each slot:

- **origin / from** (left card meta + detail meta row) — REAL when present via the optional freeform
  `**Provenance**` bullet → `provenance` (verbatim); honest-omit when absent. Not fabricated.
- **task** (detail meta row) — REAL when present: `taskRef` = a 4-hex ref parsed from `provenance`
  (`parseTaskRef` semantics, shared with memory blame); honest-omit when absent.
- **ttl** (detail meta row) — **ZERO source**: the markdown queue has no expiry concept (the 30-min
  hook-bridge plan TTL is a different channel). Stays **omitted, never fabricated**.
- **tag** (safety-class pill) — no safety-class field → omitted. `queued` shows the `queuedAt` date
  (date-only; no clock in the markdown).
- **ESTIMATE cost table** — the prototype's `$12.40 / daily budget / over remaining` table has NO
  real data → the mono block renders the real **COMMAND** (`Command/Action` bullet) instead; when
  `command` is null the block is omitted. **No cost number is ever fabricated** (task red-line).
- **Why-approval note** — no rationale field → the amber note is omitted (a rejected entry's captured
  `feedback` is echoed in a small red note instead, when present).
- **statusPill** — `● pending` / `✓ approved` / `✕ rejected` / `failed` from real `status` (the
  prototype's `· thread paused` suffix has no backing field → dropped).

## Notes

- **No approvals bus event** — the mutate only flips markdown; there is no EventBus publish, so live
  refresh is **invalidate-after-mutate** (not a subscription). By design, not a gap.
- **Overlay chrome** follows the `features/tasks/TaskModal` precedent (plain backdrop + fixed panel +
  Escape `useEffect`), the established convention for the prototype-1:1 modals, not Radix Dialog.
- Backend: the paired approvals scope (`approvals.list` + `approvals.approve/reject`,
  PENDING_APPROVALS.md parser/writer). Web is the new surface over that already-landed scope.
