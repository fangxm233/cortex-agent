Please update me when files in this folder change

The persistent desktop frame that stays mounted across route changes.
Keeps global overlays, task/thread detail state, neutral project selection, and live events mounted.
Native actions exposed by shell surfaces, including disconnect, route through the shared typed bridge in `lib/`.

| filename | role | function |
|---|---|---|
| AppShell.tsx | core | Mounts project scope, routes, overlays, notes and one prioritized update provider |
| AppFrame.tsx | view | The single full-window frame every desktop route renders: top bar above the pane row |
| TopBar.tsx | view | The 50px application bar: sidebar toggle, history arrows, menus, drag region, caption |
| WindowControls.tsx | view | App-drawn minimize / maximize / close buttons for Windows and Linux |
| PaneStateProvider.tsx | core | Owns the left rail and right panel collapse flags for every surface |
| NavigationHistoryProvider.tsx | core | App navigation stack over route, project and session |
| navigation-history.ts | util | Push, replace and dedupe rules behind the back and forward arrows |
| ShellModalsProvider.tsx | core | Owns the window-level modals the menu bar must be able to open |
| ShortcutsModal.tsx | view | Help → Keyboard shortcuts, generated from the menu model |
| AboutModal.tsx | view | Help → About: frontend build stamp and native shell version |
| DaemonStatusModal.tsx | view | Adapts the shared daemon resource to desktop confirmation, status, restart and bridge-backed disconnect controls |
| EmptyPane.tsx | view | Titled placeholder for unbuilt routes |
