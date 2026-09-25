Please update me when files in this folder change.

Desktop application frame, window chrome, navigation, and shell dialogs.

| filename | role | function |
|---|---|---|
| AboutModal.tsx | view | Show application and version information |
| about-modal.css | style | Style application information dialog |
| AppFrame.tsx | layout | Arrange top bar and floating panes |
| AppShell.tsx | entry | Compose route shell and global providers |
| DaemonStatusModal.tsx | view | Show daemon health and management actions |
| EmptyPane.tsx | view | Render an empty workspace pane |
| GlassPanel.tsx | style | Share filter-free floating pane chrome |
| NavigationHistoryProvider.tsx | state | Provide backward and forward navigation |
| navigation-history.ts | utility | Maintain navigation history entries |
| navigation-history.test.ts | test | Verify navigation history transitions |
| PaneStateProvider.tsx | state | Persist rail and context pane visibility |
| ShellModalsProvider.tsx | state | Coordinate shell dialog visibility |
| ShortcutsModal.tsx | view | List app menu keyboard shortcuts |
| TopBar.tsx | view | Render responsive window actions, search and Usage key |
| TopBar.test.tsx | test | Verify compact chrome retains labeled controls |
| top-bar.css | style | Compact top bar labels and menu spacing |
| WindowControls.tsx | view | Render native window caption actions |
| menu/ | module | Provide app menus and window commands |
