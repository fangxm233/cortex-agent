# mobile/ — Cortex mobile v3 (scheme-mobile.dc.html)

The mobile client shell + the full v3 screen set. The SPA renders a **full-bleed, edge-to-edge**
viewport with a bottom four-Tab nav (**会话 / 线程 / 任务 / 项目**); the active screen swaps through
`<Outlet/>`. Desktop is a separate router (see `RootRouter`) and is byte-identical. **The OS draws its
own status bar, dynamic island, home indicator and screen corners — we do NOT paint a mock device
frame.** Screens reserve the OS chrome via `env(safe-area-inset-*)`: headers pad the top inset; the Tab
bar / composer / non-Tab bottom gutters pad the bottom inset. Design source (GROUND TRUTH):
`context/projects/cortex-self/design/ref/scheme-mobile.dc.html` (sections 1a–1r). Raw px/hex/font by
design (§8.3, `@ds-adherence-ignore`) — the mobile palette is not in the light `proto.*` token set.

## v3 structure

The **project is the global scope**: 会话 / 线程 / 任务 only show the current project (a passive QN
scope tag in the header); the **项目 tab** shows project info + switches the current project. The 项目
tab carries an amber `需要你` count badge (pending approvals). Copy is per-screen and inline
(`const COPY = { en, zh }` + `pickCopy(useLang(), COPY)`) — the shared `i18n/vocab.ts` only holds the
tab label `project` (v3 screens deliberately avoid the vocab bottleneck).

| path | role |
|---|---|
| `mobile-tabs.ts` | **Pure** v3 Tab model: `MOBILE_TABS` (sessions/threads/tasks/**project** → `/m/*`), `activeTabId` (drill-in sub-routes map to their origin tab via `SUBROUTE_TAB`), `isTabRoute` (bottom bar shown only on the 4 tab routes), `tabBadge` (项目 amber 需要你 count). |
| `BottomTabBar.tsx` | Presentational bottom Tab bar (1a L121-126): 4 SVG icons (会话 chat / 线程 nodes / 任务 checks / 项目 folder), active `#191C22` / inactive `#98A1B0`, amber `#C99A2E` count badge on 项目, ≥44px touch, zh labels from `useVocab`. |
| `MobileShell.tsx` | Frame owner: full-bleed `100dvh` flex column + `BottomTabBar` (only on Tab routes) + the animated `<AnimatedOutlet/>` slot, wrapped in `MobileProjectProvider`; mounts the global `MNotificationProvider` (1q). Binds real `approvals.list` → 需要你 badge. |
| `MobileAnimatedOutlet.tsx` | Route-transition wrapper replacing the bare `<Outlet/>`: horizontal slide on screen swaps (iOS push/pop) — PUSH slides the incoming screen in from the right (outgoing shifts left), POP reverses, REPLACE / same-path / `prefers-reduced-motion` / **switches between the 4 bottom-Tab screens** swap instantly (no slide — the Tab bar is a flat switch, only drill-in sub-screens slide). Freezes the outgoing route element (`useOutlet()` snapshot) so both layers render until the incoming animation ends. Uses the existing Tailwind `animate-slide-*` utilities — no new deps. Pure `planTransition` / `slideAnimClasses` are unit-tested (`.test.tsx`); the DOM enter/exit is proven in the live harness. |
| `current-project.tsx` | `MobileProjectProvider` / `useMobileProject` — the mobile-wide current-project state (reuses the desktop pure `resolveCurrentProjectId`). 会话/线程/任务 scope to it; 项目 (1e) switches it. |
| `mobile-routes.tsx` / `mobile-router.tsx` | Route table + router. 4 tab routes + drill-in sub-screens `/m/session/:id` (1b) · `/m/thread/:id` (1g) · `/m/task/:id` (1h) · `/m/approvals` (1f) · `/m/new-project` (1i) · `/m/memory` (1j) · `/m/machines` (1k) · `/m/settings` (1l) · `/m/daemon` (1r). Index + catch-all → `/m/sessions`. |
| `ui/kit.tsx` | **Shared mobile UI kit** (chrome extracted 1:1 from the scheme): `MScreen`, `MTabHeader`, `MDrillHeader`, `MMoreButton`, `MScrollBody`, `MCard`, `MPill`/`statusPillTone`, `MDot`, `MGroupLabel`, `MSegmented`, `MBottomSheet`, `MComposer`, `MC` (palette), `MONO`. Every v3 screen composes these. |
| `ui/format.ts` | Pure formatters: `relTimeZh`, `fmtMoney`, `pickCopy`. |

## v3 screens (`v3/`)

Each screen = `M<X>Screen.tsx` (container: tRPC + state + nav) + `M<X>View.tsx` (pure presentational)
+ `m-<x>-vm.ts` (pure logic) + tests. All render REAL tRPC data with **honest placeholders** for fields
the contract does not carry (never fabricated; flagged `// GAP`).

| screen | files | data |
|---|---|---|
| 1a 会话列表 | `MSessionListScreen/View`, `m-session-list-vm` | `sessions.list`(direct, scoped) day-grouped; ＋→`/m/session/new`; row→chat |
| 1b 会话详情 (+1m/1n/1o/1p) | `MChatScreen`, `MChatView`, `m-chat-vm` | `sessions.transcript`+`sessions.send`/`createAndSend`+live; profile switch (`sessions.setProfile`), attachments upload, inline thread card. **1m 提问 / 1n Plan 审批: UI built + tested but NOT wired — the web tRPC contract has no session-scoped interaction/plan stream (documented gap; no fabrication).** |
| 1c 线程 | `MThreadsScreen/View`, `m-threads-vm` | `threads.list`(scoped)+`threads.get`+`cost.summary` budget band; 活跃/历史; row→`/m/thread/:id` |
| 1d 任务 | `MTasksScreen/View`, `m-tasks-vm` | `tasks.list`(scoped)+live; 进行中/可执行/阻塞; row→`/m/task/:id` |
| 1e 项目 | `MProjectScreen/View`, `m-project-vm` | `projects.list`+`cost.summary`+`threads.list`+`approvals.list`+`machines.list`; switch project; →memory/machines/settings/approvals/new-project |
| 1f 审批 | `MApprovalsScreen/View`, `m-approvals-vm` | `approvals.list`+approve/reject; first card expanded |
| 1g 线程详情 | `MThreadDetailScreen/View`, `m-thread-detail-vm` | `threads.get`+live; pipeline steps + artifacts + Σcost; `threads.cancel` |
| 1h 任务详情 | `MTaskDetailScreen/View`, `m-task-detail-vm` | `tasks.list`+`tasks.verification`; read-only; done-when/deps/history |
| 1i 新建项目 | `MNewProjectScreen/View`, `m-new-project-vm` | `projects.create` bottom sheet |
| 1j 项目记忆 | `MMemoryScreen/View`, `m-memory-vm` | `memory.tree`(scoped); read-only file/dir tree |
| 1k 机器 | `MMachinesScreen/View`, `m-machines-vm` | `machines.list` (reuses `screens/mobile-machines-vm`) |
| 1l 设置 | `MSettingsScreen/View`, `m-settings-vm` | `config.get`+`cost.summary`; budget; desktop-only editing marked 桌面编辑 |
| 1r Daemon | `MDaemonScreen/View`, `m-daemon-vm` | `system.daemonStatus`+`threads.list`+`schedules.list`+`executions.list`+`system.restart` |
| 1q 通知 | `MNotificationProvider`, `MNotificationToaster` | global banner over real `session.message`/`system.notice` (reuses desktop notification store/vm/hooks) |

## Notes

- **Render switch**: `src/RootRouter.tsx` mounts `mobileRouter` (mobile) or the desktop `router`.
- **Live data / no backend change**: every screen uses the existing `ui-service` tRPC contract; no
  agent-server change was needed for v3 (the contract already covered it).
- **`screens/` is legacy (v2, 5a–5c/10e/10f)** — superseded by `v3/` and no longer routed. It is kept
  because a few of its **pure** helpers are still reused by v3 (`mobile-session-vm` stepper/tool-chips,
  `MobileThreadStepper`, `mobile-machines-vm`); its container components are dead (tree-shaken) and can
  be removed in a later cleanup once those helpers are relocated.
- `IOSDevice.tsx` is a design-preview specimen only (NOT used by the live shell).
- Verified: `pnpm`/web `tsc --noEmit` EXIT 0; web `vitest src/mobile` all green; `vite build` EXIT 0.
