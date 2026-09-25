Please update me when files in this folder change.

The desktop chrome: the window frame, the top bar, the menus, and the three composition
files that decide what is mounted. `shell-not-to-mobile` forbids importing `mobile/`;
the two chromes are siblings. Feature pages are rendered through the router's `Outlet`,
never imported here.

## Composition

| filename | role | function |
|---|---|---|
| AppShell.tsx | entry | This chrome's root route element: `DockProvider` → `ShellProviders` → selected session / nav history / pane state / notes → `Outlet`, `ShellModalHost`, mounts, palette |
| ShellProviders.tsx | core | The set BOTH chromes mount (mobile mounts it too): live events, connection status, current project, modal registry, media viewer, doc viewer |
| ShellModals.tsx | core | `ShellModalHost` — the single mount point for all twelve global overlays, each read off its modal-registry key. A new overlay is one `defineModal` plus one line here |
| useShellModals.tsx | core | The shell's own registry keys and hooks: About, Daemon status, New project, Shortcuts |

## Frame and chrome

| filename | role | function |
|---|---|---|
| AppFrame.tsx | core | The one component that knows the window is a column: top bar, then floating panes. Shared by workbench/overview/memory/skills |
| GlassPanel.tsx | core | `glassPanelStyle` / `WorkspacePanel`: the one floating-pane chrome (deliberately no `backdrop-filter`), used by the rail and every workspace page |
| TopBar.tsx | core | Title bar: menu bar, history, search, connection, theme, Usage (opens Settings on that page) and settings actions, rail toggles, window controls — all retained when compact |
| top-bar.css | style | Compact-width label and menu spacing for the top bar |
| WindowControls.tsx | core | Minimise/maximise/close, native or web, positioned by the platform's caption insets |
| EmptyPane.tsx | core | Placeholder pane for routes with no page yet (e.g. `/threads`) |
| PaneStateProvider.tsx | core | Window-level collapsed flags for the left rail and right panel (the top bar and View menu drive them from outside the panes) |
| NavigationHistoryProvider.tsx | core | Back/forward over app locations, not URLs — session switching never changes the path |
| navigation-history.ts | core | The pure history model behind that provider (a location is route + project + session) |
| AboutModal.tsx | core | Brand, versions, build stamp and external links |
| about-modal.css | type | The About modal's own stylesheet (1:1 brand chrome) |
| ShortcutsModal.tsx | core | Help → Keyboard shortcuts, rendered from the same declaration the menus use |
| `*.test.ts(x)` | test | vitest, colocated (`navigation-history`, `TopBar`) |

`menu/` — the desktop menu bar and window commands; see `menu/AGENTS.md`.

Baseline note: `menu/useAppMenus.ts → useShellModals.tsx` is the one frozen `no-circular` entry
in `.dependency-cruiser-known-violations.json`.
