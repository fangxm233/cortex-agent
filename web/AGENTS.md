# web/ — Cortex Web UI

Vite + React 18 SPA. tRPC client + TanStack Query + React Router + token-ised Tailwind.
Path alias `@/* → src/*`. One codebase, two chromes — desktop (`shell/`) and mobile
(`mobile/`) — over one router and one shared body of `features/`. This file is the structure
map and the rulebook; per-directory file lists live in `src/**/AGENTS.md` (start at `src/AGENTS.md`).

## Directories

| Dir | What lives there | Index |
| --- | --- | --- |
| `lib/` | Bottom of the stack: platform shell (tauri/browser), tRPC transport, session, pure helpers. Knows nothing above it. | `src/lib/AGENTS.md` |
| `design/` | Primitive kit (Button, Modal, Toast, Select, BottomSheet, tones, `ChatMarkdown`, `MenuChrome`, shared content-surface CSS, mobile tokens + overlay host) + the two app-free seams: `modal-registry.tsx`, `dock-intake.tsx`. | `src/design/AGENTS.md` |
| `theme/` | Runtime appearance: palette, accent, `ThemeProvider`. | `src/theme/AGENTS.md` |
| `i18n/` | Vocab tables + `LangProvider` / `useVocab`. | `src/i18n/AGENTS.md` |
| `features/` | One directory per feature (33). The shared body both chromes render. | `src/features/AGENTS.md` |
| `features/session/` | The session/chat core both chromes render: `transcript/ interaction/ composer/ list/ live/ rail/ state/`. Imports no chrome and no page. | `…/session/AGENTS.md` |
| `features/workbench/` | The desktop three-pane page only: `rail/ chat/ composer/ right-panel/` + `WorkbenchPage.tsx`. | `…/workbench/AGENTS.md` |
| `features/settings/` | `panels/ controllers/ vm/ ui/` + `SettingsModal.tsx`, `useSettings.tsx`, `settings-nav.ts`. | `…/settings/AGENTS.md` |
| `features/update-prompt/` | Arbitration over the three update channels `server-update/ app-update/ hot-update/`; the channels import neither it nor each other. | `…/update-prompt/AGENTS.md` |
| `shell/` | Desktop chrome: frame, top bar, menus; `ShellProviders` (the set both chromes mount), `AppShell`, `ShellModals` (`ShellModalHost`). | `src/shell/AGENTS.md` |
| `mobile/` | Mobile chrome: `screens/` (Screen/View/vm triplets), `shared/`, `ui/` (mobile kit). | `src/mobile/AGENTS.md` |
| `dev/` | DEV-only demo routes `/kit`, `/base`; registered by `router.tsx` only when `import.meta.env.DEV`. | `src/dev/AGENTS.md` |
| root files | `main.tsx providers.tsx RootRouter.tsx router.tsx router-factory.ts responsive-route.tsx index.css` | `src/AGENTS.md` |

## Import direction

```
        router.tsx · RootRouter.tsx · responsive-route.tsx     ← only these pick a chrome
                 ┌──────────────┬──────────────┐
              shell/         mobile/         dev/              ← siblings, never each other
                 └──────────────┴──────────────┘
                            features/                          ← the shared body
                     design/   theme/   i18n/                  ← context-free kits
                              lib/                             ← platform + transport
```

Everything points **down**. Enforced by `.dependency-cruiser.cjs` (`pnpm -C web depcruise`):

1. `lib-is-bottom` — `lib/` imports nothing from `features/ mobile/ shell/ i18n/ design/ theme/`.
2. `foundation-not-to-app` — `design/ theme/ i18n/` never import `features/ mobile/ shell/`.
3. `features-not-to-mobile` — a feature is shared by both chromes; anything it wants from
   `mobile/ui` is a primitive and belongs in `design/`.
4. `shell-not-to-mobile` — the two chromes are siblings.
5. `mobile-only-from-router` — only the three router files import `mobile/` from outside it.
6. `dev-only-from-router` — nothing imports `dev/` except `router.tsx`; `dev/` may import anything.
7. `components-not-direct-trpc` — no `.tsx` under `features/ mobile/ shell/` imports `@/lib/trpc`;
   go through a `use*Resource` / `use*Controller` hook or a `*-vm` module.
8. `no-circular` — no module-level import cycles.

Plus, via `scripts/check-feature-cycles.mjs`: **no bidirectional edges between two
`features/<name>/` directories**. Two features importing each other are one feature, or one is
missing a seam. Type-only imports and `*.test.ts(x)` files are exempt from everything above.

## Providers

```
providers.tsx           query client · tRPC · theme · tooltip · toast · vocab · login gate
  └ ShellProviders      mounted by EACH chrome, never by the root: live stream · connection ·
                        current project · modal registry · media viewer · doc viewer
      └ per-chrome      AppShell adds dock, selected session, navigation history, pane state,
                        notes; MobileShell adds its two headless mounts and the overlay host
                        (`design/mobile-overlay-host`) that lifts sheets above its floating tab bar
          └ ShellModalHost   every global overlay, mounted once, off the registry
```

- The shared set has one definition (`shell/ShellProviders.tsx`) and two mounts; it is
  deliberately not lifted into `providers.tsx` so a chrome swap takes the live stream with it.
- **One modal registry, not a provider per modal.** `design/modal-registry.tsx` keeps a
  `Map<kind, payload>` in one `useSyncExternalStore` store. A feature declares its typed key
  with `defineModal<TPayload>(kind)` beside its modal and keeps its own hook (`useTaskModal()`,
  `useSettings()`, …): triggers call `useModalActions()` (stable, no subscription); the ONE host
  that renders the modal calls `useModal()`. A new overlay = a key + a line in `shell/ShellModals.tsx`.
- Naming: `*Provider` provides context; `*Mount` only subscribes and renders
  (`NotificationMount`, `UpdateMount` + mobile pair); `*Host` renders one modal off a registry key.
- The dock sits outside the shared set: `MediaViewerProvider`/`DocViewerProvider` read
  `design/dock-intake`, the surface `features/dock` supplies to everything that opens INTO it.

## Conventions

- **`*-vm.ts`** — pure view-model builders: no react, no tRPC, no I/O. Where the unit tests are.
- **`use*Resource` / `use*Controller`** — the only place tRPC queries and mutations live.
- **Container / View split** — `panels/XPanel.tsx` exports `XPanelView` (pure props) beside its
  container; `mobile/screens/MXScreen.tsx` + `MXView.tsx` likewise. `PluginsPanel` is the model.
- **One SSE stream** — `features/live` owns the single `EventSource`; consumers subscribe to it.

## Running the checks

```sh
pnpm -C web depcruise    # boundary rules + feature cycles   (alias: pnpm -C web lint)
pnpm -C web typecheck    # tsc --noEmit
pnpm -C web test         # vitest run  (~6s)
```

`build` runs `tsc --noEmit`, `pnpm run depcruise` and `vite build` concurrently and fails if any
of the three fails, so the release workflows
(`pnpm --filter '@cortex-agent/web...' run build`) enforce the rules.

## The baseline is a ratchet

The rules were added to a tree that already violated them. The remaining violations are frozen
in `.dependency-cruiser-known-violations.json` (skipped via `--ignore-known`) and
`scripts/feature-cycles-allowlist.json`. **Both may only shrink**: a new violation fails the
build and must be fixed, not appended; regenerating the baseline to absorb one defeats the file;
the cycle checker errors on stale allow-list entries so the list cannot outlive its cycles.

Outstanding: `components-not-direct-trpc` 55 · `no-circular` 1 · feature pairs 1 (`settings↔usage`).
List them: `pnpm -C web exec depcruise src --validate --no-ignore-known`.
