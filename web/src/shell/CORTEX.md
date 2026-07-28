Please update me when files in this folder change

The persistent desktop frame that stays mounted across route changes.
Keeps global overlays, shared selection state and the live event stream alive between pages.

| filename | role | function |
|---|---|---|
| AppShell.tsx | core | Mounts global overlays around the routed outlet |
| EmptyPane.tsx | view | Titled placeholder for unbuilt routes |
