# features/hot-update/ — 前端热更新提示 (design 21a / mobile 3a)

The Tauri shell (desktop + Android) downloads a newer SPA bundle in the background and stages it for
the next launch (see `desktop/src-tauri/src/ota.rs`). This feature raises the **hot-update prompt** in
the SPA when a bundle is staged, so the user can apply it (restart / exit) instead of waiting for a
silent swap on the next cold start. **APP-only**: off-shell (plain browser / ui-http) the native seam
is a no-op, so the prompt never appears there.

The pure layer (seam + `useHotUpdate` + formatters) is shared by both shells; only the presentation
differs — desktop renders `HotUpdateDialog` (scheme.dc.html §21a, token-only), mobile renders
`v3/MHotUpdateDialog` (scheme-mobile.dc.html §3a, raw px/hex per the mobile convention).

| path | role |
|---|---|
| `frontend-update.ts` | Native-shell seam + pure formatters. `StagedUpdate` (`{version, fromVersion?, size?}`); `onFrontendUpdateStaged(cb)` (subscribes to the `frontend-update-staged` Tauri event via global `window.__TAURI__.event`, off-shell no-op), `getStagedUpdate()` (backstop query of the `get_staged_update` command for a missed event), `applyFrontendUpdate()` (invokes `apply_frontend_update` → desktop restart / Android exit). Pure, unit-tested: `shortVersion` (hash → 8 chars, **never a fabricated semver**), `versionTransitionLabel` (`from8 → to8`), `formatUpdateSize` ("8.4 MB"), `updateSummaryLine` ("… · 8.4 MB · 已下载"), `parseStagedUpdate` (payload coercion). |
| `useHotUpdate.ts` | Hook driving the prompt: subscribes to the event + a mount-time backstop query, exposes `{staged, apply, dismiss}`. **Focus gate** (design 21a "无输入焦点时才弹"): defers showing while a text field is focused (`isEditableTarget`, pure + unit-tested), surfaces it on `focusout`. `dismiss` = 忽略 for this run (no re-prompt). Off-shell the seam no-ops so `staged` stays null. (Approval/diff gating left as a documented follow-up.) |
| `HotUpdateDialog.tsx` | **Desktop 21a** presentational modal on Radix Dialog: 420px centered, overlay ink 44%, run-blue icon square + 「新版本已就绪」 + Plex Mono version line (`updateSummaryLine`) + reassurance copy + right-aligned 「忽略」 ghost / 「重启 App」 ink. Esc / overlay click = 忽略. Token-only (zero hex). |
| `HotUpdateProvider.tsx` | Desktop wiring — `useHotUpdate` + `HotUpdateDialog`; mounted in `shell/AppShell`. Renders null when no staged update (i.e. always in a plain browser). |

The **mobile** presentation lives with the rest of the mobile v3 set: `mobile/v3/MHotUpdateDialog.tsx`
(3a full-width 「退出 App」 / 「忽略」 alert) + `mobile/v3/MHotUpdateProvider.tsx` (mounted in
`MobileShell`), both reusing this feature's `frontend-update.ts` + `useHotUpdate`.

## Native contract (desktop/src-tauri)

- Event `frontend-update-staged` — emitted by the OTA background thread after `check_and_stage`
  stages a bundle; payload = serialized `ota::StagedUpdate` (`{version, fromVersion, size}`).
- Command `get_staged_update() -> Option<StagedUpdate>` — backstop for a missed event (size = 0, not
  persisted on disk).
- Command `apply_frontend_update()` — desktop `app.restart()` (relaunch → startup `promote_staged`
  applies), Android `app.exit(0)` (system relaunch applies). Design 21a / 3a primary button.

## Notes

- Version is a **content hash**, not a semver — the prompt shows the 8-char short hash + size, never a
  fabricated `vX.Y.Z` (provenance discipline).
- `tailwind.config.ts` gains `boxShadow.overlay-strong` (`0 24px 64px rgba(16,24,40,.32)`, the 21a
  modal shadow) — desktop screens stay hex-free.
- vitest runs in the node environment (no jsdom); tests use pure helpers + `react-dom/server`
  `renderToStaticMarkup` (mobile dialog) rather than DOM-driven click simulation.
