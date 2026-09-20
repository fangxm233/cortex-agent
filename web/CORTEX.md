# web/ — Cortex Web UI

Vite + React 18 SPA. tRPC client + TanStack Query + React Router + token-ised Tailwind.
Path alias `@/* → src/*`. One codebase, two chromes: desktop (`shell/`) and mobile
(`mobile/`), sharing one body of features and one router.

This file describes the **target** structure — the state after the 4-step cleanup.
Steps 1, 2 and 3 have landed, so every row below is current; step 4 (the per-directory
index files) does not change this table.
The import rules below are enforced *today*, against the current tree.

## Directories

| Dir | What lives there |
| --- | --- |
| `lib/` | Bottom of the stack: platform shell (tauri/browser), tRPC transport, session, pure helpers. Knows nothing above it. |
| `design/` | The primitive kit — Button, Modal, Toast, Select, tone/degraded tokens, the bottom sheet, the mobile `MC`/`MONO` token tables and `ChatMarkdown` (text in, JSX out, over the parser in `lib/markdown.ts`). Plus the two seams that have to sit below every feature to be usable by all of them: `modal-registry.tsx` (which global overlays are open) and `dock-intake.tsx` (what a surface hands to the dock). App-free — it names no feature at runtime — and shared by both chromes. |
| `theme/` | Runtime appearance: palette, accent, `ThemeProvider`. |
| `i18n/` | Vocab tables + `LangProvider` / `useVocab`. |
| `features/` | One directory per feature (33 today). The shared body both chromes render. |
| `features/session/` | The session/chat core both chromes render, lifted out of `workbench/` in step 2: `transcript/` `interaction/` `composer/` `list/` `live/` `rail/` `state/` (88 files). It imports no chrome and no page — everything above it points down into it. |
| `features/workbench/` | The desktop three-pane page only, since step 2 moved the shared core to `features/session/`: `rail/` `chat/` `composer/` `right-panel/`, with `WorkbenchPage.tsx` at the root (42 files). |
| `features/settings/` | `panels/` `controllers/` `vm/` `ui/`, with `SettingsModal.tsx`, `SettingsProvider.tsx` and `settings-nav.ts` at the root (69 files) — the layering the filenames already implied, made structural in step 2. |
| `features/update-prompt/` | The arbitration layer over the three update channels `server-update/` `app-update/` `hot-update/`: it imports all three, decides which single prompt the user sees, and owns the manual check. The channels import neither it nor each other — anything they need in common sits below them in `lib/` or `design/`. |
| `shell/` | Desktop chrome: `AppFrame`, `TopBar`, panes, menus, and the three composition files — `ShellProviders` (the set both chromes mount), `AppShell` (this chrome's own providers) and `ShellModals` (`ShellModalHost`, the one mount point for the global overlays). |
| `mobile/` | Mobile chrome: `screens/` = the screen container/view pairs, `shared/` = view-models and widgets used across screens, `ui/` = the mobile kit. |
| `dev/` | DEV-only demo routes: `kit/` (every design primitive in every state, `/kit`) and `base-demo/` (the prototype specimen, `/base`). Registered by `router.tsx` only when `import.meta.env.DEV`, so they are absent from production bundles. |
| root files | `router.tsx`, `RootRouter.tsx`, `responsive-route.tsx`, `providers.tsx`, `main.tsx`. |

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

Everything points **down**. The rules, as enforced in `.dependency-cruiser.cjs`:

1. **`lib-is-bottom`** — `lib/` imports nothing from `features/ mobile/ shell/ i18n/ design/ theme/`.
   It is the floor: transport and platform, no app knowledge, not even vocab.
2. **`foundation-not-to-app`** — `design/ theme/ i18n/` never import `features/ mobile/ shell/`.
   They are imported *by* the app; importing back puts every feature in the Button's graph.
3. **`features-not-to-mobile`** — `features/` never imports `mobile/`. A feature is shared by
   both chromes, so it cannot depend on one. Anything it wants from `mobile/ui` is really a
   primitive and belongs in `design/`.
4. **`shell-not-to-mobile`** — the two chromes are siblings; neither imports the other.
5. **`mobile-only-from-router`** — only `router.tsx`, `RootRouter.tsx` and `responsive-route.tsx`
   may import `mobile/` from outside it. Keeps the mobile tree movable as a unit.
6. **`dev-only-from-router`** — nothing outside `dev/` imports `dev/`, except `router.tsx`.
   The demo pages are not product code; the only edge into them is the DEV-gated one in the
   router. `dev/` itself may import anything — it exists to show the rest of the tree off.
7. **`components-not-direct-trpc`** — no `.tsx` under `features/ mobile/ shell/` imports
   `@/lib/trpc`. A component renders; it does not open a transport. Go through a
   `use*Resource` / `use*Controller` hook or a `*-vm` module.
8. **`no-circular`** — no module-level import cycles.

Plus a rule dependency-cruiser cannot express: **no bidirectional edges between two
`features/<name>/` directories**, checked by `scripts/check-feature-cycles.mjs`. Two
features importing each other are one feature, or one is missing a seam.

Type-only imports are exempt from all of the above (runtime coupling is what we care
about), and so are `*.test.ts(x)` files — a test may import whatever it needs.

## Providers

Four layers, and only the first one is global:

```
providers.tsx           query client · tRPC · theme · tooltip · toast · vocab · login gate
  └ ShellProviders      mounted by EACH chrome, never by the root: live stream · connection ·
                        current project · modal registry · media viewer · doc viewer
      └ per-chrome      AppShell adds the dock, selected session, navigation history, pane
                        state and notes; MobileShell adds its two headless mounts
          └ ShellModalHost   every global overlay, mounted once, off the registry
```

- **The shared set is mounted per chrome.** One definition (`shell/ShellProviders.tsx`), two
  mounts, deliberately not lifted into `providers.tsx` (see `ConnectionStatusProvider`'s header):
  a chrome swap takes the live stream down with the chrome rather than leaving one up across both.
- **One registry, not a provider per modal.** `design/modal-registry.tsx` holds a
  `Map<kind, payload>` in one `useSyncExternalStore` store. A feature declares its own typed key
  with `defineModal<TPayload>(kind)` beside its modal and keeps its own hook (`useTaskModal()`,
  `useSettings()`, …): triggers call `useModalActions()` (stable callbacks, no subscription), and
  the ONE host that renders the modal calls `useModal()`. Opening one kind cannot re-render a
  subscriber of another. A new overlay is a key plus a line in `shell/ShellModals.tsx`.
- **`*Provider` means it provides context.** Something that only subscribes and renders is a
  `*Mount` (`NotificationMount`, `UpdateMount` and the mobile pair); something that renders one
  modal off a registry key is a `*Host`.
- **The dock is outside the shared set**, because `MediaViewerProvider` and `DocViewerProvider`
  read `design/dock-intake` — the five-member surface `features/dock` supplies to everything that
  opens INTO it. `useDock()` itself is for the dock's own chrome, its host and the View menu.

## Conventions worth keeping

- **`*-vm.ts`** (49 today) — pure view-model builders. No react, no tRPC, no I/O: snapshot in,
  render-ready object out. These are where the unit tests are, and they are cheap to write
  because they are pure. New display logic goes here first.
- **`use*Resource` / `use*Controller`** — the only place tRPC queries and mutations live.
  A controller owns the query keys, the invalidations and the optimistic updates for one panel.
- **Container / View split** — `mobile/screens` is the reference: `MAccountsScreen.tsx` holds the
  controllers and navigation, `MAccountsView.tsx` is presentational and takes props (21 pairs).
  `features/settings` does the same thing with `panels/XPanel.tsx` (`XPanelView` on pure props
  beside its container) + `vm/x-vm.ts` + `controllers/useXController.ts`.
- **One SSE stream** — `features/live` owns the single `EventSource`. Nothing else opens one;
  consumers subscribe to `LiveEventsProvider`.

## Running the checks

```sh
pnpm -C web depcruise    # boundary rules + feature cycles   (alias: pnpm -C web lint)
pnpm -C web typecheck    # tsc --noEmit
pnpm -C web test         # vitest run  (207 files / 1537 tests, ~6s)
```

`build` runs `tsc --noEmit && pnpm run depcruise && vite build`, so the rules are enforced by
CI — the release workflows run `pnpm --filter '@cortex-agent/web...' run build`.

## The baseline, and why it may only shrink

The rules were added to a tree that already violates them. Rather than weaken the rules, the
remaining violations are frozen in `.dependency-cruiser-known-violations.json` and skipped
via `--ignore-known`. Step 1a took the file from 75 entries to 61; step 1b was pure
restructuring and held it at 61 (regenerating it after the moves reproduces the same 61 edges
under their new paths); step 2 retired two by giving `TemplatesPanel` and `HooksPanel` the
controller every other panel has; step 3 retired three more with the dock seam, 59 -> 56:

| Rule | Frozen | Was |
| --- | --- | --- |
| `components-not-direct-trpc` | 55 | 57 |
| `no-circular` | 1 | 8 |
| `features-not-to-mobile` | 0 | 4 |
| `mobile-only-from-router` | 0 | 4 (the same 4 files) |
| `lib-is-bottom` | 0 | 2 |

Likewise `scripts/feature-cycles-allowlist.json` holds 1 known feature pair, down from 11.
Step 1b removed `app-update<->update` and `hot-update<->update` by splitting the old `update/`
into an `update-prompt/` layer above the channels and pushing what they shared into `lib/`
and `design/`. Step 2 removed the six that ran through `workbench` — `commission`, `dock`,
`media`, `memory`, `notes` and `thread` — by moving the shared module down rather than
re-exporting it: the session core to `features/session/`, `ChatMarkdown` and the markdown
parser to `design/` and `lib/`, and `attachment-presentation`, `CommissionOptIn`,
`BrowserOptIn`/`browser-status` and `NewProjectModal` to the features that own them. What is
left — `browser<->dock`, `dock<->media`, `settings<->usage` — never involved `workbench`; the
first two are both the same seam, `useDock()`, and belong to the provider question in step 3.

**Both files are ratchets.** A new violation fails the build and must be fixed, not appended.
Regenerating the baseline to absorb one defeats the entire file. Removing entries as the
violations are fixed is the point — and the cycle checker *errors on stale allow-list entries*
precisely so the list cannot outlive the cycles it was written for.

To see what is still outstanding: `pnpm -C web exec depcruise src --validate --no-ignore-known`.
