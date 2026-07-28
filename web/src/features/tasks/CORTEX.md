# features/tasks/ — Tasks tab (design 4a)

Design 4a (scheme.dc.html L624-745): renders the **real** `tasks.list` from a running
agent-server over tRPC, grouped by lifecycle (in-progress → actionable → waiting-deps →
blocked → done), and live-updates via the tRPC subscription (SSE) when a task mutation is
routed through the daemon. Proves the full stack end-to-end.

| path | role |
|---|---|
| `group-tasks.ts` | Pure `groupTasks(TaskInfo[]) → TaskGroup[]` — buckets tasks into fixed-order lifecycle groups (in-progress → actionable → waiting-deps → blocked → done), omitting empty groups, stable input order. `actionableOpenCount()` = the OPEN (not-done) count — every non-done task whatever its bucket (in-progress / blocked / waiting-deps / pending), NOT the strict `TaskInfo.actionable` predicate. It backs both the panel's Actionable/All chip and the workbench right-panel **Tasks** tab badge, which is why the two agree. `LIFECYCLE_ORDER` canonical. |
| `group-tasks.test.ts` | Unit tests for lifecycle grouping, ordering, counts, and dependency state. |
| `useTasksLiveSync.ts` | Listens on the app's SHARED live stream (`features/live`) for `task.claimed/completed/blocked/dispatched` and invalidates the `tasks.list` query on each event → refetch → re-render. (It used to open its own SSE — see `features/live/CORTEX.md` for why every hook sharing one stream matters.) |
| `TasksPanel.tsx` | Reusable data-driven body: `tasks.list` query + live-sync. **Built-in Actionable/All filter** (replaces old external Active/History scope). No "+ Task" button. No done-when display in the list. Consumed by `TasksPage` and `features/workbench/RightPanel`. |
| `TasksPage.tsx` | Route component for `/tasks`: thin page wrapper (header + `<TasksPanel />`). |
| `TaskRow.tsx` | One task card (design 4a): single-line text (ellipsis truncation) + colour-coded dot + expand toggle + mono ID + "⋯" menu + metadata pill (claimed / blocked / deps). No priority display. Opens the task detail modal (10a) on click. |
| `TaskModal.tsx` | **Task detail modal (10a), 1:1 from prototype.dc.html L1462-1540** (+ shared backdrop L1292). Exact inline styles / px / hex / font / EN copy from the source; real `tasks.list` data. Backdrop / esc-chip / Escape close. Complete → `tasks.complete`, Unblock (when `blockedBy`) → `tasks.unblock` (owned by `TasksPanel`). Opened from `TaskRow`; consumed via `TasksPanel`. |
| `task-modal-vm.ts` | **Pure** VM builder `buildTaskModalVm(task, all)` (TDD): status-pill derivation (real `status`/`actionable`/`claimedBy`/`blockedBy` → prototype's 5 tones), priority→color, Fields rows, and the **real dependency join**. Framework-free. |
| `task-modal-vm.test.ts` | Unit tests for status precedence, dependency joins, and action guards; visual palette and field-order snapshots are intentionally not locked. |
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
