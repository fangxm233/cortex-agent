# features/thread/ — thread detail 11b (center-column view) + nested 2b + pure step logic

Renders a **real `threads.get` (`ThreadDetail`, B1 task 58f3)** thread as the prototype's 11b
detail view. **Stage-R2 task 4450** rebuilt this surface **1:1 from `design/ref/prototype.dc.html`
L398–522** (exact inline styles / px / hex / font / weight / EN copy), replacing the superseded
Stage-3 token-summary presentation (`ThreadDetailPage`/`ThreadStepList`/`NestedThreadsPanel`/
`ThreadArtifactsPanel`/`InlineThreadCard` were removed). Diff targets: `proto-shots/04-thread-detail-exp.png`
(top-level) + `05-thread-detail-stats.png` (nested).

| path | role |
|---|---|
| `thread-detail-vm.ts` | **Pure** VM (TDD): `buildThreadDetailVm(detail, trail, now)` → the detail model (header fields, pill, crumbs, meta, depth dots, step rows incl. the running step's agent-flow + sub-thread cards, artifact header/written-by). Each `DetailStep` now also carries `stepIndex` / `sessionId` / `sessionName` / `profile` so **any** step (not just the running one) can render its own session chat. `threadPill` (status→pill pair) + `fmtClock` (MM:SS elapsed). Reuses `thread-steps` (`dispatchesForStep`) + `nested-threads` (`nodeLevel`/`treeMaxLevel`/`MAX_LEVEL`). |
| `thread-detail-vm.test.ts` | vitest unit tests for the pure VM (written first, RED→GREEN). |
| `ThreadDetailRoute.tsx` | **Route `/threads/:threadId`** — the center-column frame: prototype outer flex (`display:flex;height:100vh;min-width:1180px`) mounting the real `features/workbench/LeftRail` + `ThreadDetailView` (the prototype keeps the rail + hides the workbench right panel in thread view, `showRightPanel:false`). Binds `threads.get` + `useThreadGetLiveSync` + loading/error; 1s tick advances the running-thread elapsed clock; reads the ancestor breadcrumb trail from `location.state.trail`. |
| `ThreadDetailView.tsx` | 1:1 header bar (‹ back · breadcrumbs · name · tid · status pill · Pause/Cancel) + meta bar (template/started/elapsed/cost/task + depth dots) + content flex. Cancel = real `threads.cancel` mutation (→ invalidate + navigate to /workbench); Pause inert (**GAP-P**, no threads pause MutateOp). Drill-down (2b) re-roots `threads.get` on the child, carrying the `{id,name}` trail. `data-thread-detail`. |
| `ThreadPipeline.tsx` | PIPELINE column: connectors, collapsed step cards, and one expanded step at a time. Expansion is **click-driven** (click any step to expand it) and defaults to following the active/running step (falls back to the last step on a terminal thread); the expanded step shows its agent session as a CHAT (`ThreadStepChat`) + SUB-THREADS sub-cards with `open ›` drill. The data-bound chat is injected via `renderStepChat` (default = the live `ThreadStepChat`) so the presentational pipeline stays testable without tRPC/query providers. `data-pipeline`/`data-active-step`/`data-expanded-step`/`data-sub-thread-id`/`data-drill-thread-id`. |
| `ThreadStepChat.tsx` | Per-step chat: fetches the step's own `sessions.transcript` (keyed by `ThreadStepDetail.sessionId`), builds rows with the workbench pure `buildTranscriptRows`, and renders them via the reused presentational `ChatRows` — so a step's assistant output is Markdown (`ChatMarkdown`) with collapsed tool-call rows (`ToolCallsRow`), exactly like the center chat. For the running (`live`) step it also opens `useSessionMessageLiveSync` so output streams in real time; completed steps show the reconciled history only. |
| `ThreadArtifactPanel.tsx` | 1:1 THREAD ARTIFACT card (L488–520): header (path · live badge · updated · Open ↗) + REFERENCES body (real refs) + WRITTEN BY footer (from steps). **GAP-artifact-body**: the rich body (RESULT/METRICS/tail) needs the artifact file content → fs-read scope (plan §2.1, Stage 6); refs + written-by are real, a muted note points at the Memory viewer. `data-thread-artifact`. |
| `thread-detail-render.test.tsx` | `react-dom/server` render checks of `ThreadPipeline` + `ThreadArtifactPanel` (browser E2E environment-blocked — persistent SSE; live proof is the CDP harness below). |
| `thread-steps.ts` | **Pure** (kept): `selectActiveStep` · `dispatchesForStep` (join by `agentSlotId`) · `activeStepChildren` · `stepSummaryParts`. Consumed by `thread-detail-vm` + workbench `RightThreadCard`/`thread-card-proto`. |
| `thread-steps.test.ts` | vitest for `thread-steps.ts` (10 tests). |
| `nested-threads.ts` | **Pure** (kept): `nodeLevel` (child depth→display level, root=1) · `isMaxLevel` (≥5 or truncated) · `countDescendants` · `treeMaxLevel` (clamped ≤5) · `flattenOutline` · `INLINE_MAX_VISIBLE_LEVEL`. Consumed by `thread-detail-vm` + workbench `right-panel-vm`/`RightThreadCard`. |
| `nested-threads.test.ts` | vitest for `nested-threads.ts` (14 tests). |
| `useThreadGetLiveSync.ts` | One SSE subscription on `thread.created/step.*/completed/failed` → invalidate `threads.get` for this `threadId` → refetch. Reused by the detail route + workbench inline/right cards. |

## Notes

- **Host**: the detail view is reached via the workbench right-panel "Detail" link, the ⌘K palette
  (Thread items route to `/threads/:id`), and 2b drill-down. It renders inside `AppShell` (global ⌘K
  preserved) as a full-viewport frame with the real Left Rail.
- **No backend change**: consumes only the existing `threads.get` (B1) + `threads.cancel` + `subscribe`.
- **Data-driven, not stage-name-matched**: the active step surfaces whatever children the DTO carries
  (dispatches/subthreads). `ThreadChildNode` has no owning-step field → subthreads attributed at thread
  level under the active step.
- **Depth / B1 off-by-one**: clamped to `MAX_LEVEL`=5 (`x/5` meter), truncated nodes marked max — a
  B1 concern, not this view.
- **Step chat (per-step transcript)**: each step's expanded content is the full agent conversation for
  its `sessionId` (via `sessions.transcript` + the live `session.message` stream on the running step),
  rendered with the reused workbench chat pieces (`buildTranscriptRows` → `ChatRows` → `ChatMarkdown` /
  `ToolCallsRow`). This supersedes the earlier `agentFlow.lastOutput`-only feed — assistant output is
  now Markdown with tool-call rows, streaming live, and any step is clickable to inspect. No backend
  change (the `sessionId` was already on `ThreadStepDetail`).
- **Flagged gaps** (paired stage): **GAP-artifact-body** (RESULT/METRICS need fs-read — Stage 6);
  **GAP-P** Pause (no threads pause MutateOp); ancestor crumb names ride the drill trail (real, no new
  scope). Local coder threads persist **no subthreads/dispatches**, so the SUB-THREADS + nested-crumb
  (05) paths are **unit + render tested**, not live (same env as F1/F2).
- **Verified live** (task 4450): real dist ui-http-server + real `threadStore`/`taskStore`/
  `sessionStore`/`getCostSummary` (133 real threads) serving built `web/dist` behind `x-cortex-token`;
  headless-Chrome CDP at 1440×900 (token via `Network.setExtraHTTPHeaders`) → gate 401(no)/200(yes);
  `/threads/thr_24289550` (real running coder-review) rendered the frame (rail **240** / artifact
  **440**), header/meta/PIPELINE/THREAD ARTIFACT/WRITTEN BY/REFERENCES all present, collapsed `1·plan`
  + expanded running `2·implement` with real agent flow, **0 console errors**. Side-by-side vs
  `proto-shots/04-thread-detail-exp.png` at `design/build-shots/4450-thread-detail-vs-04-sidebyside.png`.
