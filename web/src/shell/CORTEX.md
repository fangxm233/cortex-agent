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
| AppFrame.tsx | core | The one component that knows the window is a column: top bar, then panes. Shared by workbench/overview/memory/skills |
| TopBar.tsx | core | Title bar: menu bar, window title, connection and rail toggles, window controls |
| WindowControls.tsx | core | Minimise/maximise/close, native or web, positioned by the platform's caption insets |
| EmptyPane.tsx | core | Placeholder pane for routes with no page yet (e.g. `/threads`) |
| PaneStateProvider.tsx | core | Window-level collapsed flags for the left rail and right panel (the top bar and View menu drive them from outside the panes) |
| NavigationHistoryProvider.tsx | core | Back/forward over app locations, not URLs — session switching never changes the path |
| navigation-history.ts | core | The pure history model behind that provider (a location is route + project + session) |
| AboutModal.tsx | core | Brand, versions, build stamp and external links |
| about-modal.css | type | The About modal's own stylesheet (1:1 brand chrome) |
| ShortcutsModal.tsx | core | Help → Keyboard shortcuts, rendered from the same declaration the menus use |
| `*.test.ts(x)` | test | vitest, colocated (`navigation-history`) |

## menu/

The desktop menu bar. One declaration (`menu-model.ts`) drives three consumers: the
dropdown hint, the global key handler, and the shortcuts sheet.

| filename | role | function |
|---|---|---|
| menu-model.ts | core | The menu tree + accelerators — the single declaration the other three read |
| MenuBar.tsx | core | The in-window dropdown menu bar (web mode and platforms without a native menu) |
| useAppMenus.ts | core | Builds the live menu tree from app state and binds each item to its action |
| useNativeMenu.ts | core | Sends that tree to the shell, which turns it into a real `tauri::menu::Menu` |
| useMenuShortcuts.ts | core | The single global keydown handler; typing wins over accelerators except ⌘K and window commands |
| useWindowActions.ts | core | Observable window state (zoom, fullscreen) and the actions that report their own failures |
| window-commands.ts | core | Serialized fullscreen transitions and checked native window calls |
| `*.test.ts(x)` | test | vitest, colocated (menu-model, useAppMenus, useWindowActions, window-commands) |

Baseline note: `useAppMenus.ts → useShellModals.tsx` is the one frozen `no-circular` entry
in `.dependency-cruiser-known-violations.json`.
