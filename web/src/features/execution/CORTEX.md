# features/execution/ — execution log drawer (09-exec-logs)

Stage-R2 task b963 (design §8.6). The **execution log drawer** overlay — a right dark slide-over
reproduced **1:1** from `design/ref/prototype.dc.html` L1542–1562 (+ shared backdrop L1292), diffed vs
`design/proto-shots/09-exec-logs.png`. Wired to **real** tRPC data: `executions.get`
(`ExecutionDetailInfo`, B2-A) for the header (title / status pill / meta), a **live-scrolling
`cortex-run` log stream** (B2-C `executions.log` SSE subscription) in the dark body, and a working
**Kill run** (`executions.cancel`). **Replaces** the old Stage-3 8b execution *detail page* (task 2198
— `ExecutionDetailPage`/`Rail`/`LogStreamView` deleted, route `/executions/:executionId` removed).

| path | role |
|---|---|
| `execution-log-view.ts` | **Pure** drawer derivations (TDD): `execPill(status)` (prototype glyph+label), `execMeta(detail)` (`machine · taskId · finished <HH:MM> \| running`, null segments dropped), `execClock`/`execNow` (UTC HH:MM / HH:MM:SS), `isStoppable` (running only), `logStreamEnabled` (dispatch.runName present). Framework-free. |
| `execution-log-view.test.ts` | vitest unit tests for projection semantics and edge cases. |
| `log-buffer.ts` | **Pure** bounded-log reducer (TDD): `appendLog(state, frame, cap)` folds `execution.log` frames into a ring capped at `cap` lines; folds backend flood drops + client cap eviction into one `dropped` total; ignores replayed frames (`seq ≤ lastSeq`). `EMPTY_LOG` seed. |
| `log-buffer.test.ts` | vitest unit tests for the reducer. |
| `useExecutionLogStream.ts` | Thin React/SSE glue: opens one `executions.log` subscription (gated on `enabled`), reads each UiEvent's `payload.{lines,seq,dropped}`, folds into `appendLog` (`LOG_CAP`=2000). Resets on executionId change; closes on unmount. |
| `ExecutionLogDrawer.tsx` | The dark Radix drawer binds `executions.get`, the gated live log stream, and running-only cancellation with toast/invalidation. `data-execution-log` / `data-action="kill-run"` remain the E2E contract; drawer colors, copy, clock text, and line counts are not duplicated in static-render tests. |
| `ExecutionLogDrawerProvider.tsx` | Global mount + `useExecutionLogDrawer()` context (`open(id)`/`close()`). One drawer instance; any dispatch row opens it with an executionId. Mounted in `shell/AppShell` (mirrors the ⌘K palette mount). |

## Notes

- **Backend**: unchanged (B2 task dd2b — `executions.get`, `ExecutionLogTailer` + `execution.log`
  event, `executions.log` subscribe wiring; real per-exec GPU 032e). Web-only task.
- **Triggers**: `features/thread/ThreadStepList` (dispatch row) and `features/workbench/RightThreadCard`
  (`DispatchCard`) call `useExecutionLogDrawer().open(executionId)` instead of navigating to a route.
- **UiEvent wrapper**: log frames arrive as `{ type:'execution.log', ts, payload:{ lines, seq,
  dropped? } }` — the log data is on `event.payload` (`subscribe.ts`).
- **Live log only for cortex-run launches**: subscribable only when the daemon registered a `runName`
  for the dispatch (`logStreamEnabled`); otherwise the dark body shows a "no live log" note. Kill still
  works via `executions.cancel`.
- **Real log lines are opaque strings** — the prototype's per-line timestamp/color split is mock-only,
  so each raw line renders in the single body tone (`#C6CBE8`) at the exact mono 10.5px/2. Structure is
  1:1; the log data is the variable (§8.3).
- **Status/meta live-refresh** is a 3s poll (`refetchInterval` while running) — no `execution.*`
  lifecycle bus event exists (only `execution.log`). The log itself is push (SSE). Kill invalidates
  `executions.get` so the header pill flips to cancelled.
- **No extend-cap** in this drawer — the prototype footer is the static heartbeat line + Kill run only
  (the old rail's Extend-cap affordance is gone). done_when requires only Kill, which is real.
