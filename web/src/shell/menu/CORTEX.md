Please update me when files in this folder change

The desktop application menus. One declaration of File / Edit / View / Help drives the in-window
menu bar, the global accelerator handler and the Help → Keyboard shortcuts sheet, so the three can
never disagree. Before this folder the app had four ad-hoc `keydown` listeners and no way to
discover a shortcut from the UI.

| filename | role | function |
|---|---|---|
| menu-model.ts | util | Menu node types plus accelerator parsing, display formatting and key matching |
| useAppMenus.ts | core | Assembles the four menus from every window-level provider |
| useMenuShortcuts.ts | core | The single global keydown handler that runs the menus' accelerators |
| useWindowActions.ts | core | Native window chrome, zoom, fullscreen and devtools operations |
| MenuBar.tsx | view | The in-window bar and its dropdowns, including submenus and check marks |

Two rules worth knowing before editing:

- An item marked `accelDisplayOnly` shows its accelerator but is not bound here. The clipboard block
  is implemented natively by the webview, and ⌘K belongs to the command palette's own handler —
  binding either again would double-fire, and re-dispatching ⌘K would recurse.
- Accelerators are suppressed while the user is typing, except for the few in `ALWAYS_ACTIVE`.
