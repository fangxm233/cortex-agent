Please update me when files in this folder change.

One directory per feature (33 today) — the shared body both chromes render. A feature owns
its data hooks, its view-models and its components; it may import `lib/ design/ theme/ i18n/`
and other features, and nothing above it.

## Rules

1. **No feature imports `mobile/`** (`features-not-to-mobile`). A feature is shared by both
   chromes, so it cannot depend on one. Anything wanted from `mobile/ui` is a primitive and
   belongs in `design/`.
2. **No bidirectional pair** of `features/<a>` ↔ `features/<b>`, checked by
   `scripts/check-feature-cycles.mjs` over 62 inter-feature edges. One allow-listed pair
   remains: `settings↔usage` (`scripts/feature-cycles-allowlist.json`). Two features that
   import each other are one feature, or one of them is missing a seam.
3. **No `.tsx` imports `@/lib/trpc` directly** (`components-not-direct-trpc`) — go through a
   `use*Resource` / `use*Controller` hook or a `*-vm` module. 35 of the 56 frozen baseline
   entries are here; the baseline is a ratchet that may only shrink.
4. Type-only imports and `*.test.ts(x)` files are exempt from all of the above.

## Features

| dir | what it owns |
|---|---|
| `approvals/` | The approval center overlay: queue hook, pure center view-model, registry key |
| `app-update/` | Native app update channel: check, dialog, `useAppUpdate` |
| `attachments/` | Upload store, upload call, and the presentation shape a chip/card renders from |
| `auth/` | Browser-mode login: `UiAuthGate`, token login, provider icons, the login-flow provider and modal |
| `browser/` | The docked browser pane: target resolution, port forward, opt-in, status, frame title |
| `command-palette/` | ⌘K: the global toggle and the flat item model over sessions / threads / tasks |
| `commission/` | Commission mode: the board modal, banner, opt-in, asset URLs, live sync |
| `connection/` | `ConnectionStatusProvider` — is the UI talking to the agent-server, derived from the shared stream |
| `daemon/` | Daemon status modal + resource hook |
| `dock/` | The workbench's fourth pane: tab strip, split, file bodies, `DockProvider`. Supplies `design/dock-intake` |
| `execution/` | The execution/log drawer and its hooks-free presentational view |
| `hot-update/` | OTA frontend update channel: check, dialog, `useHotUpdate` |
| `issues/` | The Issues modal and the view-model shared with the Overview cards and mobile 24c |
| `live/` | `LiveEventsProvider` — the ONE `EventSource`. Nothing else opens a stream |
| `machines/` | Machine list resource + detail view-model |
| `media/` | Media lightbox and document viewer: pdf.js pager, html sandbox, kinds, zoom, object URLs, video posters |
| `memory/` | The memory page: tree, markdown view, view-model |
| `notes/` | Project notes: provider, pane, overview card, resource hook, view-model |
| `notifications/` | The notification feed, DM/system notices, OS notify, turn buffering, `NotificationMount` |
| `overview/` | The Overview page and its view-model |
| `projects/` | `CurrentProjectProvider`, project sessions, project creation and the New Project modal |
| `provider-setup/` | The `/setup/providers` onboarding route styled as the native install wizard |
| `rate-limit/` | Rate-limit status pill and its view-model |
| `schedule/` | The schedule modal, its editor controller and view-model |
| `server-update/` | Agent-server update channel: dialog + `useServerUpdate` |
| `session/` | The session/chat core both chromes render (88 files) — see `session/CORTEX.md` |
| `settings/` | The settings modal and every panel (69 files) — see `settings/CORTEX.md` |
| `skills/` | The Skills page and view |
| `tasks/` | Tasks page/panel, the task modal, grouping, dependencies, claim, verification, live sync |
| `thread/` | Thread detail modal and view, pipeline, step chat, artifact panel, nesting, controller |
| `update-prompt/` | The arbitration layer over the three channels: decides which single prompt shows, owns the manual check and `UpdateMount`. The channels import neither it nor each other |
| `usage/` | Usage panel, policy controls and view-model |
| `workbench/` | The desktop three-pane page only (42 files) — see `workbench/CORTEX.md` |

To see what the ratchets still hold:
`pnpm -C web exec depcruise src --validate --no-ignore-known`.
