Please update me when files in this folder change

Persistent desktop frame, navigation and window-level overlays.
Hosts global detail state, live events and native shell actions.

| filename | role | function |
|---|---|---|
| AppShell.tsx | core | Mounts project scope, routes, overlays and updates |
| AppFrame.tsx | view | Renders the top bar and desktop pane row |
| AppFrame.test.tsx | test | Checks fullscreen space and compact header |
| TopBar.tsx | view | Render the 34px navigation and window-control bar |
| WindowControls.tsx | view | Renders native window controls |
| PaneStateProvider.tsx | core | Owns left rail and right panel collapse state |
| NavigationHistoryProvider.tsx | core | Owns route, project and session navigation history |
| navigation-history.ts | util | Pushes, replaces and deduplicates navigation |
| navigation-history.test.ts | test | Covers navigation history transitions |
| ShellModalsProvider.tsx | core | Owns window-level menu dialogs |
| ShortcutsModal.tsx | view | Displays menu keyboard shortcuts |
| AboutModal.tsx | view | Shows Cortex branding, versions and project links |
| about-modal.css | style | Styles the responsive, theme-aware About dialog |
| AboutModal.test.tsx | test | Covers About rendering, version states and links |
| DaemonStatusModal.tsx | view | Shows daemon status, restart and disconnect |
| EmptyPane.tsx | view | Titled placeholder for unbuilt routes |
