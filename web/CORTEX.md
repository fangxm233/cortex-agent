# web/ — Cortex Web UI

Vite + React 18 SPA. tRPC client + TanStack Query + React Router + token-ised Tailwind.
Path alias `@/* → src/*`. One codebase, two chromes: desktop (`shell/`) and mobile
(`mobile/`), sharing one body of features and one router.

This file describes the **target** structure — the state after the 4-step cleanup.
Rows and notes marked **(planned)** do not exist yet; everything else is current.
The import rules below are enforced *today*, against the current tree.

## Directories

| Dir | What lives there |
| --- | --- |
| `lib/` | Bottom of the stack: platform shell (tauri/browser), tRPC transport, session, pure helpers. Knows nothing above it. |
| `design/` | The primitive kit — Button, Modal, Toast, Select, tone/degraded tokens, the bottom sheet and the mobile `MC`/`MONO` token tables. Context-free, and shared by both chromes. |
| `theme/` | Runtime appearance: palette, accent, `ThemeProvider`. |
| `i18n/` | Vocab tables + `LangProvider` / `useVocab`. |
| `features/` | One directory per feature (33 today). The shared body both chromes render. |
| `features/session/` | **(planned)** the session/thread domain currently spread across `thread/`, `commission/`, parts of `workbench/`. |
| `features/workbench/` | **(planned sub-dirs)** `rail/` `chat/` `composer/` `right-panel/` — it is the biggest feature and flat today. |
| `features/settings/` | **(planned sub-dirs)** `panels/` `controllers/` `vm/` — the split already exists by filename, not by directory. |
| `shell/` | Desktop chrome: `AppFrame`, `TopBar`, panes, menus, modal providers. |
| `mobile/` | Mobile chrome. **(planned)** `screens/` = today's `v3/`, `shared/` = today's `screens/` (vms), `ui/` = the mobile kit (unchanged). |
| `dev/` | **(planned)** DEV-only routes — today's `features/kit` + `features/base-demo`. |
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
6. **`components-not-direct-trpc`** — no `.tsx` under `features/ mobile/ shell/` imports
   `@/lib/trpc`. A component renders; it does not open a transport. Go through a
   `use*Resource` / `use*Controller` hook or a `*-vm` module.
7. **`no-circular`** — no module-level import cycles.

Plus a rule dependency-cruiser cannot express: **no bidirectional edges between two
`features/<name>/` directories**, checked by `scripts/check-feature-cycles.mjs`. Two
features importing each other are one feature, or one is missing a seam.

Type-only imports are exempt from all of the above (runtime coupling is what we care
about), and so are `*.test.ts(x)` files — a test may import whatever it needs.

## Conventions worth keeping

- **`*-vm.ts`** (48 today) — pure view-model builders. No react, no tRPC, no I/O: snapshot in,
  render-ready object out. These are where the unit tests are, and they are cheap to write
  because they are pure. New display logic goes here first.
- **`use*Resource` / `use*Controller`** — the only place tRPC queries and mutations live.
  A controller owns the query keys, the invalidations and the optimistic updates for one panel.
- **Container / View split** — `mobile/v3` is the reference: `MAccountsScreen.tsx` holds the
  controllers and navigation, `MAccountsView.tsx` is presentational and takes props (21 pairs).
  `features/settings` does the same thing with `XPanel.tsx` + `x-vm.ts`.
- **One SSE stream** — `features/live` owns the single `EventSource`. Nothing else opens one;
  consumers subscribe to `LiveEventsProvider`.

## Running the checks

```sh
pnpm -C web depcruise    # boundary rules + feature cycles   (alias: pnpm -C web lint)
pnpm -C web typecheck    # tsc --noEmit
pnpm -C web test         # vitest run  (205 files / 1534 tests, ~6s)
```

`build` runs `tsc --noEmit && pnpm run depcruise && vite build`, so the rules are enforced by
CI — the release workflows run `pnpm --filter '@cortex-agent/web...' run build`.

## The baseline, and why it may only shrink

The rules were added to a tree that already violates them. Rather than weaken the rules, the
remaining violations are frozen in `.dependency-cruiser-known-violations.json` and skipped
via `--ignore-known`. Step 1a took the file from 75 entries to 61:

| Rule | Frozen | Was |
| --- | --- | --- |
| `components-not-direct-trpc` | 57 | 57 |
| `no-circular` | 4 | 8 |
| `features-not-to-mobile` | 0 | 4 |
| `mobile-only-from-router` | 0 | 4 (the same 4 files) |
| `lib-is-bottom` | 0 | 2 |

Likewise `scripts/feature-cycles-allowlist.json` holds 11 known feature pairs.

**Both files are ratchets.** A new violation fails the build and must be fixed, not appended.
Regenerating the baseline to absorb one defeats the entire file. Removing entries as the
violations are fixed is the point — and the cycle checker *errors on stale allow-list entries*
precisely so the list cannot outlive the cycles it was written for.

To see what is still outstanding: `pnpm -C web exec depcruise src --validate --no-ignore-known`.
