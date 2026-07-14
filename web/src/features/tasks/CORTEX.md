# features/tasks/ — Tasks tab (design 4a)

Design 4a (scheme.dc.html L624-745): renders the **real** `tasks.list` from a running
agent-server over tRPC, grouped by lifecycle (in-progress → actionable → waiting-deps →
blocked → done), and live-updates via the tRPC subscription (SSE) when a task mutation is
routed through the daemon. Proves the full stack end-to-end.

| path | role |
|---|---|
| `group-tasks.ts` | Pure `groupTasks(TaskInfo[]) → TaskGroup[]` — buckets tasks into fixed-order lifecycle groups (in-progress → actionable → waiting-deps → blocked → done), omitting empty groups, stable input order. `actionableOpenCount()` for the tab badge. `LIFECYCLE_ORDER` canonical. |
| `group-tasks.test.ts` | vitest unit test for the lifecycle grouping logic (12 tests, TDD — written first). |
| `useTasksLiveSync.ts` | Opens one SSE subscription (`task.claimed/completed/blocked/dispatched`) via the vanilla tRPC client and invalidates the `tasks.list` query on each event → refetch → re-render. |
| `TasksPanel.tsx` | Reusable data-driven body: `tasks.list` query + live-sync. **Built-in Actionable/All filter** (replaces old external Active/History scope). No "+ Task" button. No done-when display in the list. Consumed by `TasksPage` and `features/workbench/RightPanel`. |
| `TasksPage.tsx` | Route component for `/tasks`: thin page wrapper (header + `<TasksPanel />`). |
| `TaskRow.tsx` | One task card (design 4a): single-line text (ellipsis truncation) + colour-coded dot + expand toggle + mono ID + "⋯" menu + metadata pill (claimed / blocked / deps). No priority display. Opens the task detail modal (10a) on click. |
| `Pills.tsx` | `PriorityPill` / `StatusPill` — token-driven (tailwind §5 pill palette), no hard-coded hex. Used in the modal, not in TaskRow. |
| `TaskModal.tsx` | **Task detail modal (10a), 1:1 from prototype.dc.html L1462-1540** (+ shared backdrop L1292). Exact inline styles / px / hex / font / EN copy from the source; real `tasks.list` data. Backdrop / esc-chip / Escape close. Complete → `tasks.complete`, Unblock (when `blockedBy`) → `tasks.unblock` (owned by `TasksPanel`). Opened from `TaskRow`; consumed via `TasksPanel`. |
| `task-modal-vm.ts` | **Pure** VM builder `buildTaskModalVm(task, all)` (TDD): status-pill derivation (real `status`/`actionable`/`claimedBy`/`blockedBy` → prototype's 5 tones), priority→color, Fields rows, and the **real dependency join**. Framework-free. |
| `task-modal-vm.test.ts` | vitest for `task-modal-vm.ts` (22 tests, TDD — written first). |
| `task-verification-vm.ts` | **Pure** VM builder `buildTaskVerificationVm(info)` (TDD) for the Dispatch-history card over the real `tasks.verification` scope. Framework-free. |
| `task-verification-vm.test.ts` | vitest for `task-verification-vm.ts` (11 tests, TDD — written first). |

## Task detail modal (10a) — real data + honest placeholders

The modal is built 1:1 from the prototype. Card A's WHY line + DONE-WHEN row bind the **real**
`TaskInfo.why` / `TaskInfo.doneWhen` (task store `why` / `done-when`; `doneWhen` is a single string,
not a checklist array — the store has no array field). When a task genuinely records neither, the
italic-muted placeholder shows (null-safe, no fabrication).

**Card C (Dispatch history)** consumes the **real** `tasks.verification` scope via `useQuery` inside
the modal (fires on open only). (The former Card B "Done-when verification" evidence card was removed
per user request — done-when itself still shows in Card A.)

- **Card C** renders the real per-task execution/dispatch rows (newest first: id · machine · when ·
  duration · cost; the completing run is highlighted). Honest "no dispatches recorded" when empty.
- **GAP-GPU** — no `gpu` on `TaskInfo` → Fields `gpu` renders `—` (matches the T-046 proto-shot).

**Real** in the modal: id · title (`text`) · derived status pill · priority color · template ·
claimed-by · **why · doneWhen** · **Dependencies** (real `dependsOn` + reverse join) · **dispatch
history** (`tasks.verification`) · Complete/Unblock mutations.

## Notes

- Live update requires a **daemon-routed** mutation: `taskMutator` publishes `task.claimed` /
  `task.completed` / `task.blocked` only in-process. An external `cortex-task` CLI mutation does
  NOT emit a bus event, so it will not drive a live refresh. `task.unclaimed` / `task.unblocked`
  events do not exist — unclaim/unblock are intentionally absent from this slice's actions.
- Typed against the real `AppRouter` (Stage-1 task 3); see `src/lib/trpc.ts` for why the old
  forward-compat conditional seam was removed (deferred conditionals do not auto-tighten).
