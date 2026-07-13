# features/tasks/ — Tasks tab (design 4a)

Stage-1 task 5 vertical slice: renders the **real** `tasks.list` from a running agent-server
over tRPC, grouped by lifecycle · priority, and live-updates via the tRPC subscription (SSE)
when a task mutation is routed through the daemon. Proves the full stack end-to-end.

| path | role |
|---|---|
| `group-tasks.ts` | Pure `groupTasks(TaskInfo[]) → { open, done }` — splits by lifecycle (open before done), then by priority (high→medium→low), omitting empty groups, stable order. `PRIORITY_ORDER` canonical. |
| `group-tasks.test.ts` | vitest unit test for the grouping logic (TDD — written first). |
| `useTasksLiveSync.ts` | Opens one SSE subscription (`task.claimed/completed/blocked/dispatched`) via the vanilla tRPC client and invalidates the `tasks.list` query on each event → refetch → re-render. |
| `TasksPanel.tsx` | Reusable data-driven body: `tasks.list` query + live-sync + Claim/Complete mutations (`tasks.claim` / `tasks.complete`) + grouped render with loading/error/empty states. Optional `lifecycle?: 'open'\|'done'` restricts to one lifecycle (the workbench Active/History filter passes it; `/tasks` omits it → both). Consumed by `TasksPage` and `features/workbench/RightPanelTabs`. |
| `TasksPage.tsx` | Route component for `/tasks`: thin page wrapper (header + `<TasksPanel />`, both lifecycles). |
| `TaskRow.tsx` | One task row, **two rows** (prototype): row 1 = task text + **Unblock** action (only when blocked); row 2 = metadata labels (id · template · @claimant · blocked). Deliberately NOT shown: priority, the "open" status, Claim, Complete (those live in the modal). Carries `data-task-id` / `data-status` for E2E driving. **The row opens the task detail modal (10a) on click**; the Unblock button `stopPropagation`. |
| `Pills.tsx` | `PriorityPill` / `StatusPill` — token-driven (tailwind §5 pill palette), no hard-coded hex. |
| `TaskModal.tsx` | **Task detail modal (10a), 1:1 from prototype.dc.html L1462-1540** (+ shared backdrop L1292). Exact inline styles / px / hex / font / EN copy from the source; real `tasks.list` data. Backdrop / esc-chip / Escape close. Complete → `tasks.complete`, Unblock (when `blockedBy`) → `tasks.unblock` (owned by `TasksPanel`). Opened from `TaskRow`; consumed via `TasksPanel` → covers both `/tasks` and the workbench Tasks tab. |
| `task-modal-vm.ts` | **Pure** VM builder `buildTaskModalVm(task, all)` (TDD): status-pill derivation (real `status`/`actionable`/`claimedBy`/`blockedBy` → prototype's 5 tones), priority→color, Fields rows, and the **real dependency join** (upstream from `dependsOn` + downstream from reverse-scan of `tasks.list`; dot/label by dep state). Framework-free so the DTO→prototype-value mapping is unit-tested in isolation. |
| `task-modal-vm.test.ts` | vitest for `task-modal-vm.ts` (22 tests, TDD — written first). |
| `task-verification-vm.ts` | **Pure** VM builder `buildTaskVerificationVm(info)` (TDD) for Card B/C over the real `tasks.verification` scope: maps done-when evidence + per-task dispatch rows (status→color, duration/cost/when formatters, `isCompleting` flag), plus the honest-placeholder flags (`hasEvidence` / `hasDispatches`). Framework-free. |
| `task-verification-vm.test.ts` | vitest for `task-verification-vm.ts` (11 tests, TDD — written first). |

## Task detail modal (10a) — real data + honest placeholders

The modal is built 1:1 from the prototype. Card A's WHY line + DONE-WHEN row bind the **real**
`TaskInfo.why` / `TaskInfo.doneWhen` (task store `why` / `done-when`; `doneWhen` is a single string,
not a checklist array — the store has no array field). When a task genuinely records neither, the
italic-muted placeholder shows (null-safe, no fabrication).

**Card B (Done-when verification)** + **Card C (Dispatch history)** now consume the **real**
`tasks.verification` scope via `useQuery` inside the modal (fires on open only):

- **Card B** renders the done-when achievement EVIDENCE — real `completed-at` + `completed-note` +
  the completing execution's id/`finalOutput`. Honest placeholders when the task is not completed,
  has no note, or has no linked execution (never fabricated). A `✓ completed` / `not completed` pill
  reflects real status.
- **Card C** renders the real per-task execution/dispatch rows (newest first: id · machine · when ·
  duration · cost; the completing run is highlighted). Honest "no dispatches recorded" when empty.
- **GAP-GPU** — no `gpu` on `TaskInfo` → Fields `gpu` renders `—` (matches the T-046 proto-shot).

**Real** in the modal: id · title (`text`) · derived status pill · priority color · template ·
claimed-by · **why · doneWhen** · **Dependencies** (real `dependsOn` + reverse join) · **done-when
evidence + dispatch history** (`tasks.verification`) · Complete/Unblock mutations.

## Notes

- Live update requires a **daemon-routed** mutation: `taskMutator` publishes `task.claimed` /
  `task.completed` / `task.blocked` only in-process. An external `cortex-task` CLI mutation does
  NOT emit a bus event, so it will not drive a live refresh. `task.unclaimed` / `task.unblocked`
  events do not exist — unclaim/unblock are intentionally absent from this slice's actions.
- Typed against the real `AppRouter` (Stage-1 task 3); see `src/lib/trpc.ts` for why the old
  forward-compat conditional seam was removed (deferred conditionals do not auto-tighten).
