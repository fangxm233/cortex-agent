# mobile/ — mobile shell base (web-only, design 5a–5c bottom Tab)

The viewport-driven mobile shell: on a mobile viewport (≤ `MOBILE_MAX_WIDTH`, i18n) the SPA renders
the ported iOS device frame + a bottom 4-Tab nav with the active screen swapped through `<Outlet/>`.
Desktop is unaffected (a separate router; see `RootRouter`). Ported 1:1 from `design/ref/ios-frame.jsx`
(device frame) + `scheme.dc.html` L2995-3000 / L3188-3191 (bottom Tab). Each screen is a **STUB slot**
a later pass replaces behind its own export (RB f528 frame-owner precedent). Raw px/hex/svg by design
(§8.3) — the mobile palette is not in the light `proto.*` token set.

| path | role |
|---|---|
| `IOSDevice.tsx` | Ported iOS 26 device frame (`IOSDevice` + `IOSStatusBar`): 402×874 bezel r48, dynamic island (126×37), status bar (9:41 + signal/wifi/battery glyphs), home indicator (139×5). Verbatim from `design/ref/ios-frame.jsx`. The source's `IOSNavBar`/`IOSKeyboard`/`IOSList` are not ported (screens own their headers). |
| `IOSDevice.test.tsx` | `react-dom/server` render checks (frame/island/home-indicator/time). |
| `mobile-tabs.ts` | **Pure** Tab model: `MOBILE_TABS` (sessions/threads/tasks/machines → `/m/*` + vocab label key), `activeTabId(pathname)`, `isTabRoute(pathname)` (true only for the 4 tab paths → the shell hides the bar for non-Tab sub-screens 10e/10f), `tabBadge(id, {activeThreadCount, hasPendingApproval})` (线程 count badge / 会话 amber dot). |
| `mobile-tabs.test.ts` | vitest units for the pure Tab logic (TDD, written first). |
| `mobile-tasks.ts` | **Pure** 5c task logic: `classifyMobileTask` (blocked→in-progress→claimable→waiting-deps precedence), `groupMobileTasks` (open-only buckets), `executableCount`/`allOpenCount` (可执行 = in-progress+claimable / 全部 = all open), `orderedGroups(grouped, segment)`, `MOBILE_GROUP_DOT` (verbatim scheme dot hex). |
| `mobile-tasks.test.ts` | vitest units for the 5c grouping/counts (TDD, written first). |
| `BottomTabBar.tsx` | Presentational bottom Tab bar (props-driven; MobileShell binds real counts). Exact scheme chrome: 4 tabs with SVG icons, active `#191C22`/inactive `#98A1B0`, `#4655D4` active-thread badge, `#C99A2E` amber approval dot, ≥44px touch targets, zh labels from `useVocab`. |
| `BottomTabBar.test.tsx` | `react-dom/server` render checks (labels/active/badge/dot/touch). |
| `MobileShell.tsx` | Frame owner: `IOSDevice` + `BottomTabBar` (rendered only when `isTabRoute` — non-Tab 10e/10f hide it) + scroll `<Outlet/>`. Fetches real `threads.list` (active filter, reuses `features/workbench/scope`) → 线程 badge and `approvals.list` (pending) → 会话 amber dot. |
| `mobile-routes.tsx` | Pure route config `mobileRoutes` (MobileShell layout + the 6 screen slots + index/`*` redirect to `/m/sessions`). Separate from the router instance so it is inspectable without a browser history. |
| `mobile-router.tsx` | The concrete `mobileRouter` (browser/hash by shell mode). |
| `mobile-router.test.ts` | Structural test of `mobileRoutes` (path set, 5 STUB routes navigable, index + catch-all). |
| `screens/` | Screen slots: **all 6 slots are now live** — 5a/5b/5c/10e/10f and **机器 (12c, task 5e62)**. No remaining STUB slots. See below for each screen. |
| `screens/MobileSessionsScreen.tsx` | **Session screen 5a** (task c880) — 1:1 rebuild from `scheme.dc.html` L2932-3003: session header (QN avatar/title/`running·turns·$`) + chat stream (dark user bubble / collapsed tool chips / assistant + inline experiment-pipeline stepper card / over-budget approval card) + composer (input + running status line + send). `running` is snapshot + delta (2026-07-14 fix): `SessionInfo.running` + the live `session.status` event via the shared `useSessionMessageLiveSync`, same rule as desktop CenterChat (was the streaming heuristic only). Real tRPC: `sessions.transcript` (chat) · `threads.get` (inline card) · `approvals.list`+`approve`/`reject` (approval card) · `sessions.send` (send). Missing fields (session cost/elapsed) → explicit `—`, never fabricated. The bottom Tab is the shell's (not re-rendered). |
| `screens/{MobileSessionHeader,MobileMessageStream,MobileThreadStepper,MobileApprovalCard,MobileComposer}.tsx` | 5a presentational + wired parts (`MobileInlineThreadCard`/`MobileApprovalCardContainer` bind real tRPC). Pure `mobile-session-vm.ts` maps DTOs → the scheme slot model (initials/status-line/ZH divider/horizontal stepper/approval desc/tool chips). |
| `screens/mobile-session-vm.test.ts` · `screens/mobile-session-render.test.tsx` | 5a pure-logic units + `react-dom/server` render checks (neutral props, 守则11). |
| `screens/MobileApprovalsScreen.tsx` | **Mobile approval screen 10e** — 1:1 from `scheme.dc.html` L3200-3247. `MobileApprovalsView` (pure, render-tested: ‹back header + `N 待处理` badge + `PENDING_APPROVALS.md` + first-card expanded decision + collapsed queue rows + 本周已处理 divider + ✓/✕ processed rows + Slack footer + 28px gutter) and the container binding real `approvals.list` + `approvals.approve`/`approvals.reject` (invalidate-after-mutate; back → `/m/sessions`). Honest placeholders (851f precedent): operation→tier pill, impact→判定 box; from-thread / per-type metric OMITTED; no fabrication. |
| `screens/mobile-approvals-vm.ts` | **Pure** VM `buildMobileApprovalsVm(entries, now?)` → `{ pendingCount, firstCard, queueRows, processedRows }` (851f honest field mapping + 7-day this-week window). |
| `screens/mobile-approvals-vm.test.ts` · `screens/mobile-approvals-render.test.tsx` | vitest units (TDD, written first) + `react-dom/server` render checks. |
| `screens/MobileTasksScreen.tsx` | **5c 任务 (real)** — binds `tasks.list` + `useTasksLiveSync` + `tasks.unblock`; owns segment (可执行/全部) + per-card expand + pending state. |
| `screens/MobileTasksView.tsx` | Presentational 5c view (1:1 scheme L3110-3186, raw px/hex/font §8.3): 任务 header + 可执行/全部 segmented + grouped list (进行中/可认领/等依赖/已阻塞, status dots) + claimable-card expand→DONE-WHEN (**real `TaskInfo.doneWhen`**; honest placeholder `mDoneWhenGap` only when the task has none) + blocked-card 「解除」 (≥44px). Bottom Tab is shell-owned, not rendered here. |
| `screens/MobileTasksView.test.tsx` | `react-dom/server` render checks (marker/gutter/segments/4 groups/expand real done-when + null→placeholder/blocked 解除/deps). |
| `screens/MobileMachinesScreen.tsx` | **机器 screen 12c (real)** — binds `machines.list` (joined view: machines.json + live client-manager + executionRegistry). Exports `MobileMachinesView` (pure, render-tested: header title + online/total badge + machine cards with online-dot/name/OS/liveRuns/GPU/connected-since + empty state) and `MobileMachinesScreen` (container). Honest placeholders (守则11): cortexPath/sshConfigured/lastHeartbeat/capabilities omitted (no card slot). |
| `screens/mobile-machines-vm.ts` | **Pure** VM: `MachineCardVm` interface, `fmtConnectedZh(iso, now)` (relative ZH time), `machineCardVm(m)`, `buildMobileMachinesVm(machines[])`. connectedAt null when offline (stale DTO value hidden). |
| `screens/mobile-machines-vm.test.ts` · `screens/mobile-machines-render.test.tsx` | vitest units (18, TDD written first) + `react-dom/server` render checks (18). |
| `screens/screens.test.tsx` | Structural contract guard for the machines screen via `MobileMachinesView` (no providers needed). Updated from stub → pure-view test when machines screen went live (12c). |

### 5b 移动端线程 (task ad9c) — REAL, 1:1 from `scheme.dc.html` L3005–3108

| path | role |
|---|---|
| `screens/MobileThreadsScreen.tsx` | **5b container** replacing the stub behind the same export. Header (线程 + 活跃/历史 segment + 今日 budget band) + thread-card list + full-page drill (整页下钻). Real tRPC: `threads.list` (list + 活跃 count), `threads.get` (via `MobileThreadCard`), `cost.summary` (budget band). `useThreadsLiveSync` live refresh. Owns `segment` + `trail` (drill) state; L3「打开 ›」pushes an in-screen re-rooted `threads.get` view (no `/m/threads/:id` route — stays in the slot) with ‹ 返回 back. |
| `screens/MobileThreadCard.tsx` | **One card container**: lazy `threads.get` on expand (running default-open), real `threads.cancel` on 取消 + `useThreadGetLiveSync`. Delegates rendering to `MobileThreadCardView`. Mirrors desktop `RightThreadCard`. |
| `screens/MobileThreadViews.tsx` | **Presentational** (prop-driven, render-tested): `MobileThreadsHeader` · `MobileThreadCardView` (collapsed Card B / expanded Card A) · `MobileStepTree` · `MobileSubCard` (L2 in-place expand) · `MobileDrillRow` (L3「打开 ›」). Exact scheme px/hex/font/weight (§8.3). **Reuses the desktop L2/L3 rules verbatim**: `right-panel-vm` (`stepDotKind`/`threadPill`/`depthInfo`/`formatCost`), `thread/thread-steps` (`dispatchesForStep`), `thread/nested-threads` (`nodeLevel`) — only the mobile chrome is re-authored. |
| `screens/mobile-thread-vm.ts` | **Pure** mobile-only glue (TDD): `budgetBand` (honest `today / —`, GAP-B), `pillLabel` (zh status text via vocab — the desktop `threadPill` hardcodes EN), `threadMetaLineZh`, `threadSubLine`, `stepTimeLabel`/`fmtClock`. |
| `screens/mobile-thread-vm.test.ts` / `MobileThreadViews.test.tsx` | vitest (14) + `react-dom/server` render checks (8), TDD written first. |

**5b data gaps (守则11 honest placeholders, NO fabrication):** GAP-B budget denominator — `CostSummary`
has `today` only, no budget limit → `today / —`, 0% bar (real today). GAP-subprogress — `ThreadChildNode`
has status only, no inner step list → the L2 pill shows zh status (no `运行 2/3` fraction), the
`✓collect·●re-derive·○report` progress row is omitted; L2 expands to its real L3 children. GAP-gpu —
`ThreadStepDetail` has no machine field → the `gpu-01·lab-4090` inline label shows only a real joined
`dispatch.machine`, else omitted. B1 `step N/N` off-by-one inherited (meta shows `步骤 2/1`). Local coder
threads persist no subthreads/dispatches → the L2/L3/depth-dot render paths are unit + render tested, not
live (same env as F1/F2). i18n: added `step`/`depth`/`pendingApproval` vocab keys.

### 10f 移动端项目 Overview (task 82ff) — REAL, 1:1 from `scheme.dc.html` L3249–3298

| path | role |
|---|---|
| `screens/MobileOverviewScreen.tsx` | **10f project Overview (real)** — 1:1 from `scheme.dc.html` L3249–3298 (‹ 返回 + 项目头, 非 Tab 页): 成本卡 (今日 $ + 预算带 + 14 天柱状 + 本周/本月/预测) + 项目记忆卡 (文件行 + +/- 徽标 + 全部→) + 调度卡 (条目 + 恢复 + 新建) + 执行流水行. Single-column compression of desktop 6a. Real tRPC: `cost.summary` + `memory.tree` + `schedules.list` + `executions.list`. **REAL cost fields (task bbfe, `CostSummary` c489 additions, mirrors desktop 302b): 预算分母 = `dailyBudget` (`formatPerDay`); 预算带 % = today ÷ `dailyBudget` (`budgetPercent`→`budgetPercentLabel`, `—%`/empty when no denom); 14 天柱状 = real `dailyCost` series (`dailySeriesBars`, last = today highlighted); 预测今日 = real `forecastToday`.** Remaining honest placeholders (6a df67 / memory 7b precedent): memory line-level +/- diff · 草稿 badge, schedule last-run outcome, inert 全部→/+新建/exec→; no fabrication. |
| `screens/overview-mobile-vm.ts` | **Pure** ZH view-model for 10f (`projectAvatarInitials`, `relTimeZh`, `intervalLabelZh`, `nextRunLabelZh`, `lastRunLabelZh`, `countTodayExecutions`, `activeThreadCountLabelZh`, **`budgetPercentLabel`** — bar % text, `—%` when null); reuses `overview-vm.deriveActiveProjectId`/`formatMoney`/**`budgetPercent`/`formatPerDay`/`dailySeriesBars`** (task bbfe). TDD (`overview-mobile-vm.test.ts`, 18). |

## Notes

- **Render switch**: `src/RootRouter.tsx` reads `useIsMobile()` (i18n) and mounts `mobileRouter`
  (mobile) or the unchanged desktop `router`. Two separate configs → the desktop path is
  byte-identical (no regression). `src/main.tsx` renders `<RootRouter/>` inside `<Providers>`
  (so `useIsMobile` resolves).
- **i18n**: labels come from `useVocab()`; on the mobile viewport the vocab is zh (会话/线程/任务/机器).
  Added a `sessions` vocab key. `isMobile` is derived off the same `matchMedia` breakpoint as the
  language (`useIsMobile`), so layout and language never disagree.
- **Live data**: badge/dot use the existing `threads.list` + `approvals.list` contract — no backend
  change. `approvals.list` is a Stage-R3 scope; an older daemon without it yields no dot (honest 0).
- **STUB base**: this task delivers only the frame + tabs + routing; the 5 named screens
  (5a/5b/5c/10e/10f) are slots siblings fill. `机器` is a shell-owned placeholder (scheme draws no
  mobile machines screen).
- **Verified**: web `vitest` green (5 mobile suites, 35 tests) + `pnpm -w typecheck` EXIT=0; live
  headless-Chrome render at 500×1000 (≤767 → mobile) showed the iOS frame + zh 4-Tab + active state
  + live thread badge + home indicator (`design/build-shots/0325-mobile-shell.png`); desktop router
  byte-identical (no regression).
