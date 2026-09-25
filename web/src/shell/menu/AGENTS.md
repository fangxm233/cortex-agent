Please update me when files in this folder change.

The desktop menu bar. One declaration (`menu-model.ts`) drives three consumers: the
dropdown hint, the global key handler, and the shortcuts sheet.

| filename | role | function |
|---|---|---|
| menu-model.ts | core | The menu tree + accelerators — the single declaration the other three read |
| MenuBar.tsx | core | The in-window dropdown menu bar (web mode and platforms without a native menu); compact menus with readable shortcuts |
| useAppMenus.ts | core | Builds the live menu tree from app state and binds each item to its action |
| useNativeMenu.ts | core | Sends that tree to the shell, which turns it into a real `tauri::menu::Menu` |
| useMenuShortcuts.ts | core | The single global keydown handler; typing wins over accelerators except ⌘K and window commands |
| useWindowActions.ts | core | Observable window state (zoom, fullscreen) and the actions that report their own failures |
| window-commands.ts | core | Serialized fullscreen transitions and checked native window calls |
| `*.test.ts(x)` | test | vitest, colocated (menu-model, useAppMenus, useWindowActions, window-commands) |

Baseline note: `useAppMenus.ts → ../useShellModals.tsx` is the one frozen `no-circular` entry
in `.dependency-cruiser-known-violations.json`.
