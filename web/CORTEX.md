# web/ — @cortex-agent/web

Cortex Web UI: Vite + React 18 + TypeScript SPA (Stage-1). Renders the
three-pane workbench shell; talks to agent-server over tRPC (HTTP/SSE) via `@trpc/client`
+ TanStack Query. Design tokens (design §5) live in `tailwind.config.ts` — no screen
hard-codes hex.

## Theming (light / dark)

Every color resolves to a CSS variable defined in `src/index.css` (`:root` = light /
`[data-theme="dark"]` = dark), so the whole UI (desktop + mobile) re-themes when `data-theme`
flips on `<html>`. The dark palette is a 1:1 encoding of `design/ref/scheme-dark.dc.html`
(per-level remap: elevation via surface lightness, semantic colors brightened + translucent tint
bg, ink-solid elements inverted to light-bg/dark-fg — NOT a color inversion; `--ink-solid-fg-dim` is
the softened on-ink ink used for provisional text, e.g. a chat message the model has not read yet,
where the surface must stay untouched and only the text may dim). The Tailwind tokens
(`proto.*`/`state.*`/`pill.*`/`surface.*`) and the mobile `MC` palette both point at these
variables; raw inline `style` hexes were migrated to `var(--…)`. `src/theme/` owns the persisted
choice (localStorage `cortex.theme`, default = OS `prefers-color-scheme`), mirroring `src/i18n/`.
The theme toggle lives in two places on desktop: the **left-rail footer** (a compact ☀/☾ segmented
chip — `features/workbench/LeftRail.tsx`, which replaced the old EN/中 language chip there) and the
Settings **Appearance** panel (first nav entry, `features/settings/AppearancePanel.tsx`, alongside the
language switch); mobile = the **主题/Theme** row in `mobile/v3/MSettingsView`.
A no-flash inline script in `index.html` sets `data-theme` before first paint.

## Layout

| path | role |
|---|---|
| `tailwind.config.ts` | **All** design tokens: §5 state palette / status-pill bg/fg pairs / surfaces / 8px grid / radius / shadow, **plus the prototype 1:1 base (design §8.6 RA, task 6d21)** — `fontFamily.sans`/`mono` match the prototype exactly, the audited `proto.*` color scale (ink/line/accent/amber tints), and the 16 `cx*` animation utilities. No screen hard-codes hex |
| `index.html` | SPA entry; `#root` + `/src/main.tsx`; loads **IBM Plex Mono** (Google Fonts, wght 400;500;600) matching the prototype helmet |
| `src/index.css` | Tailwind directives + the prototype `<style>` base **verbatim** (§8.6 RA): html/body reset (base `#E9E7E2` + exact system-sans stack), `input{}` reset, `.sess-row` hover, and the 16 raw `@keyframes cx*` (literal names — inline `animation:cx…` in prototype-1:1 markup depends on them) |
| `vite.config.ts` | React plugin; `@` → `src` alias; dev proxy `/trpc` → `127.0.0.1:3004`. Proxy injects `x-cortex-token` (from `CORTEX_CLIENT_TOKEN`) so the token-gated ui-http-server is reachable in dev without the browser holding the secret (SSE cannot set headers) |
| `postcss.config.js` | tailwindcss + autoprefixer |
| `index.html` | SPA entry; `#root` + `/src/main.tsx` |
| `src/main.tsx` | React root; wraps `Providers` + `RootRouter` |
| `src/RootRouter.tsx` | **Shell render switch**: `useIsMobile()` → mounts `mobile/mobile-router` (mobile) or the desktop `router`. Mobile is selected ONLY by the dedicated mobile client shell (`isMobileShell()` = `window.__CORTEX_MOBILE__`), **not** by viewport width — resizing a browser window never switches to mobile. |
| `src/mobile/` | **Mobile shell base** (web-only, design 5a–5c, task 0325) — ported `IOSDevice` frame + bottom 4-Tab nav (会话/线程/任务/机器 from `useVocab`, active state + live active-thread badge + amber approval dot, ≥44px touch) + `/m/*` routing with 5 STUB screen slots (5a/5b/5c/10e/10f) siblings replace. See its CORTEX.md |
| `src/i18n/` | Real, **user-controlled + persisted** language (`useLang`/`useSetLang`, localStorage `cortex.lang`, default en / zh from navigator) — the switch now lives in the Settings **Appearance** panel (EN/中 segmented control, next to the theme toggle); decoupled from viewport. `useIsMobile` now reflects the mobile client shell (`isMobileShell`), not width. `useVocab` → the active-language vocab, including the desktop DEBUG transcript inspector labels. See `lang.ts`/`vocab.ts`/`LangProvider.tsx`. |
| `src/theme/` | Real, **user-controlled + persisted** color theme (`useTheme`/`useSetTheme`/`useToggleTheme`, localStorage `cortex.theme`, default = OS `prefers-color-scheme`) — applied via `data-theme="dark"` on `<html>`. Drives the CSS-variable dark palette (scheme-dark.dc.html). Toggle in the left-rail footer (☀/☾ chip) + the Settings Appearance panel (desktop) / mobile 主题 row. See `theme.ts`/`ThemeProvider.tsx`. |
| `src/providers.tsx` | `QueryClientProvider` + tRPC `TRPCProvider` + `ThemeProvider` + `design/TooltipProvider` + `ToastProvider` + `LangProvider` |
| `src/lib/trpc.ts` | `@trpc/tanstack-react-query` context + vanilla client + **conditional transport** (task 1b60). `splitLink`: query/mutate → `httpBatchLink`, subscription → `httpSubscriptionLink`. **Two modes**: browser/ui-http (no config) — relative `/trpc`, same-origin, proxy injects token; desktop/remote (injected `RemoteConfig{serverUrl,token}`) — absolute URL, `x-cortex-token` in batch headers, `eventsource` npm ponyfill for SSE (fetch-based, injects token in custom fetch). Exports `trpcUrl(config?)`, `buildBatchHeaders(config?)`, `buildSseFetch(token)` for unit testing. `src/lib/trpc.test.ts` covers both modes. |
| `src/router.tsx` | `createBrowserRouter`: `AppShell` layout; `/workbench` → `WorkbenchPage` (design 3a, task 5b0f), `/tasks` → `TasksPage` (task 5), `/kit` → `KitPage` (design demo, task e794), other routes still `EmptyPane` |
| `src/design/` | Design-system core primitives (design §5 Stage 2, tasks e794/2add) — token-driven StatusPill/MonoText/ID/Card/SectionHeader/Button/Tabs/Tooltip/EmptyState/DegradedState (10c status language). See its CORTEX.md |
| `src/shell/` | `AppShell` (**Stage-R RB pass-through**, task f528 — renders `<Outlet/>` + the global ⌘K `CommandPalette`; the old token-summary nav `LeftRail` was removed — `/workbench` owns its own frame + rail) · `EmptyPane` (wraps `design/EmptyState`) |
| `src/features/workbench/` | **App-shell frame + 22a dual-zone Left Rail + Center Chat + Right Panel** — `WorkbenchPage` = 240/fluid/400 three-pane flex frame; `LeftRail` refactored to scheme §22a (top: PROJECTS always expanded, fixed order, single-click/⌘1–9 switch, real running/attention badges (unread+action, action amber) + idle age; draggable divider; bottom: current-project SESSIONS with `+ New` ⌘N in the zone header; all-projects approval pill). See its CORTEX.md |
| `src/features/tasks/` | Tasks tab vertical slice (design 4a, task 5) — see its CORTEX.md. `TasksPanel` = reusable data-driven body (also used by the workbench Tasks tab); `Pills.tsx` delegates to `design/StatusPill` |
| `src/features/live/` | **The app's single live-event stream** — one shared SSE subscription (`LiveEventsProvider`, outermost in both shells) carrying the fixed union of event types, fanned out client-side to every live surface via `useLiveEvents(types, handler, scope?)`. Replaces the six independent subscriptions the UI used to hold, which exactly exhausted a browser's per-origin HTTP/1.1 connection cap and left thumbnails/uploads queued forever on a direct plain-HTTP origin. Pure `live-events` (union, scope filter with server parity, contained fan-out, reconnect epoch) plus typed `config.changed` handling that invalidates `config.get` after a successful profile hot reload. See its CORTEX.md |
| `src/features/connection/` | **Live UI↔server connectivity** — `ConnectionStatusProvider` (mounted in both shells) derives the badge from the shared live stream's link state (`features/live` → `useLiveConnection()`); pure `connection-status` VM maps it to connected/(re)connecting/disconnected. It no longer opens its own empty-event SSE probe. Drives the LeftRail daemon badge (was always-green). See its CORTEX.md |
| `src/features/command-palette/` | ⌘K command palette **1:1 rebuild** (Stage-R2 overlay, task c967) on `cmdk` — prototype-exact overlay chrome + real sessions/threads/tasks search (substring filter, capped) + section-nav commands, keyboard-reachable. See its CORTEX.md |
| `src/features/thread/` | Thread detail 11b **center-column view rebuilt 1:1 from the prototype** (Stage-R2 task 4450) — `/threads/:id` = real LeftRail frame + header/meta/PIPELINE/THREAD-ARTIFACT over `threads.get` (B1); nested 2b drill-down; pure `thread-detail-vm`. Superseded the Stage-3 token-summary detail. See its CORTEX.md |
| `src/features/execution/` | Execution detail 8b (task 2198) — `executions.get` rail + live `executions.log` stream + Stop (`executions.cancel`), route `/executions/:executionId`. See its CORTEX.md |
| `src/features/memory/` | **Memory viewer 7b** 1:1 rebuild — route `/memory` = real LeftRail frame + 200px file tree (`memory.tree`) + rendered Markdown of the selected file (`memory.file`) + diff-toggle bar; hand-rolled pure Markdown parser (`markdown.ts`); honest placeholders for git-diff metadata (no backend scope). See its CORTEX.md |
| `src/features/schedule/` | **New-schedule overlay 7c** 1:1 rebuild (prototype L1431–1459, proto-shot 13) — global `ScheduleModalProvider` (mounted in `AppShell`) + `ScheduleModal` with TYPE-driven fields (interval/daily/weekly/once) + real `schedules.add` mutation; opened from the Overview Schedules `+ New`. See its CORTEX.md |
| `src/features/settings/` | **Settings modal 12a–g 1:1** (Stage-R2+) — route `/settings` = Radix-Dialog modal over the workbench (prototype L721–1088, proto-shot 14); 210px nav + 9 panels over real `config.get`; Budget panel drives a real `config.set` write. See its CORTEX.md |
| `src/features/approvals/` | **Approval center overlay 7a** 1:1 rebuild (Stage-R3) — centered 1120×700 modal (prototype L1317-1405, proto-shot 03/20) over real `approvals.list` + `approvals.approve`/`approvals.reject`; global `ApprovalsProvider` mount in `AppShell`, opened from the left-rail banner + inline approval card. Honest placeholders for prototype-only fields (COMMAND mono block replaces the fabricated ESTIMATE table). See its CORTEX.md |
| `src/features/issues/` | **Issues modal sec-24 (24a/24b)** — 1150×730 overlay isomorphic to the approval center over the real `issues.*` scope (`issues.list` / `issues.delete` / `issues.handle` = new session carrying the issue full text, then entry removal); global `IssuesProvider` mount in `AppShell`, opened from the Overview header `N issues` stat + Overview Issues card (both hidden at 0). No amber / no status pill by design (issues never block). See its CORTEX.md |
| `src/features/notifications/` | **DM-message notification toasts 18a** — surfaces Cortex's replies in direct chat sessions as scheme-18a floating toasts over the live `session.message` stream (no backend change); gated to `origin='direct'`, suppresses the open chat, mounted globally in `AppShell`. Pure `notification-vm`/`notification-store` (unit-tested) + `NotificationToaster` (1:1 scheme 18a) + `useDmNotifications`/`NotificationProvider` glue. See its CORTEX.md |
| `src/features/hot-update/` | **Frontend hot-update prompt 21a / 3a** — raises "新版本已就绪" when the Tauri shell stages a newer SPA bundle (OTA), so the user can restart/exit to apply. Native seam `frontend-update.ts` (listens for the `frontend-update-staged` event, `apply_frontend_update`/`get_staged_update` commands; off-shell no-op → **APP-only**) + `useHotUpdate` (focus-gated show + dismiss-for-run) + desktop `HotUpdateDialog`/`HotUpdateProvider` (scheme 21a, token-only, mounted in `AppShell`). Mobile presentation = `mobile/v3/MHotUpdate*` (scheme 3a). Shows the content-hash short id, never a fabricated semver. See its CORTEX.md |
| `src/features/kit/` | `/kit` design-system demo surface (tasks e794/2add) — every primitive in every variant/state + degraded-4 (10c) via `DegradedDemos.tsx` + empty-state next-action panels (10d), pure presentational |
| `src/features/base-demo/` | `/base` prototype 1:1 base specimen (§8.6 RA, task 6d21) — type specimens (sans + IBM Plex Mono), the audited `proto.*` palette swatches, and the 16 `cx*` animations live; pure presentational, for visual diff vs the prototype |

## Notes

- Depends on `@cortex-agent/ui-contract` (`workspace:*`) for the `AppRouter` type + zod schemas — type-only, no backend runtime coupling.
- **Tasks tab live** (Stage-1 task 5): `/tasks` renders real `tasks.list` grouped by lifecycle·priority and live-updates via the tRPC subscription. Verified end-to-end against a running ui-http-server (real render + live update on a real Complete mutation).
- **Workbench live** (Stage-R RB): `/workbench` renders the real 1:1 three-pane frame — LeftRail (f528), CenterChat (89e7 → **S4 chat aba0**: real `sessions.transcript` render + `sessions.send` + live `session.message` streaming), RightPanel (1e96) — all over real tRPC data with live subscriptions. Machines is a placeholder (Stage 7).
- Dev boots without agent-server (proxy engages only on `/trpc` request). Live data needs the port-3004 ui-http-server (task 3) and `CORTEX_CLIENT_TOKEN` set in the dev shell (proxy injects it).
- `build` = `tsc --noEmit && vite build`; `typecheck` = `tsc --noEmit`; `test` = `vitest run` (`group-tasks` grouping + `design/tone` status→tone mapping pure-logic unit tests).
- Tailwind pinned to v3.4 (config-file token contract; v4 moves tokens to CSS `@theme`).
- Tabs/Tooltip use `@radix-ui/react-tabs` / `@radix-ui/react-tooltip` (approved primitive layer, design §1); token-only styling.
- **⌘K command palette 1:1** (Stage-R2 overlay, task c967): `features/command-palette/` on `cmdk`
  (`^1.1.1`), mounted globally in `AppShell`, rebuilt 1:1 from `prototype.dc.html` L1295–1315
  (proto-shot `01-cmdk-palette.png`) — exact overlay chrome/anatomy/copy, flat rows, real
  `sessions.list`/`threads.list`/`tasks.list` search (own substring filter, `shouldFilter={false}`,
  capped) + section-nav commands; navigates via React Router. Verified: side-by-side vs the proto-shot
  (`design/build-shots/c967-cmdk-compare.png`), live headless-Chrome render of real session rows + live
  filter, real task rows rendered in a connection-pool-relaxed run. File/Approvals/schedule legs
  deferred (no fs-read scope / overlays not yet built).
