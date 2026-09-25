Please update me when files in this folder change.

Web UI source root. Path alias `@/* → src/*`. One codebase, two chromes — desktop
`shell/` and mobile `mobile/` — over one router and one shared body of `features/`.
Target structure, enforced import rules and the violation baseline: `web/AGENTS.md`.

## Root files

| filename | role | function |
|---|---|---|
| main.tsx | entry | Mount `#root` in StrictMode as `<Providers><RootRouter/></Providers>` |
| providers.tsx | core | The global layer: query client, tRPC client (awaits the native shell's injected config), theme, tooltip, toast, vocab, login gate |
| RootRouter.tsx | core | `RouterProvider` for the one router, plus the desktop `ToastViewport` (mobile keeps its own banner stack) |
| router.tsx | core | The single route table: `/setup/providers`, the desktop `AppShell` subtree, `mobile/mobile-routes`, and DEV-only `/kit` + `/base` |
| router-factory.ts | utility | `createShellRouter` — hash router inside a native shell, browser router in a tab |
| responsive-route.tsx | core | `ResponsiveRoute` layout guard + `layoutDestination`; redirects a route belonging to the other chrome, one history for both |
| index.css | style | Tailwind layers, the verbatim `cx*` prototype keyframes, base styles, palette material and focus rings over the `public/theme.css` tokens |
| vite-env.d.ts | type | Vite client + `import.meta.env` type declarations |
| `*.test.ts(x)` | test | vitest, colocated (`responsive-route`, `router-factory`) |

## Directories

| dir | what lives there | index |
|---|---|---|
| `lib/` | Bottom of the stack: platform shell, tRPC transport, session, pure helpers | `lib/AGENTS.md` |
| `design/` | Primitive kit, shared surface CSS + the two app-free seams (modal registry, dock intake) | `design/AGENTS.md` |
| `theme/` | Runtime appearance: theme, accent, palette, `ThemeProvider` | `theme/AGENTS.md` |
| `i18n/` | Bilingual vocab tables + `LangProvider` / `useVocab` | `i18n/AGENTS.md` |
| `features/` | 33 feature directories — the shared body both chromes render | `features/AGENTS.md` |
| `shell/` | Desktop chrome: frame, top bar, menus, provider/modal composition | `shell/AGENTS.md` |
| `mobile/` | Mobile chrome: routes, tabs, screens, mobile kit | `mobile/AGENTS.md` |
| `dev/` | DEV-only demo routes, absent from production bundles | `dev/AGENTS.md` |

Most feature directories carry their own `AGENTS.md`; the three large ones (`session/`,
`workbench/`, `settings/`) index their sub-directories in theirs. Start at `features/AGENTS.md`.

## Provider topology

```
providers.tsx          query client · tRPC · theme · tooltip · toast · vocab · login gate
 └ shell/ShellProviders   mounted by EACH chrome, never by the root: live stream ·
                          connection · current project · modal registry · media/doc viewers
     └ per-chrome         AppShell: dock, selected session, nav history, pane state, notes
                          MobileShell: its two headless mounts + the mobile overlay host
         └ ShellModalHost every global overlay, mounted once, keyed off the modal registry
```

## Running the checks

```sh
pnpm -C web depcruise    # boundary rules + feature cycles   (alias: pnpm -C web lint)
pnpm -C web typecheck    # tsc --noEmit
pnpm -C web test         # vitest run  (227 files / 1688 tests, ~6s)
```
