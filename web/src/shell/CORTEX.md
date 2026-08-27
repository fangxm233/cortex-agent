Please update me when files in this folder change

The persistent desktop frame that stays mounted across route changes.
Keeps global overlays, task/thread detail state, neutral project selection, and live events mounted.
Native actions exposed by shell surfaces, including disconnect, route through the shared typed bridge in `lib/`.

| filename | role | function |
|---|---|---|
| AppShell.tsx | core | Mounts project scope, routes, overlays, notes and one prioritized update provider |
| DaemonStatusModal.tsx | view | Adapts the shared daemon resource to desktop confirmation, status, restart and bridge-backed disconnect controls |
| EmptyPane.tsx | view | Titled placeholder for unbuilt routes |
