Please update me when files in this folder change

The docked pane beside the workbench chat: one tab strip whose tabs are either file previews or live web pages.
The model is pure and generic over tab identity; the pane keeps every tab body mounted so a switch never destroys one.
Per-file actions live in the body, not the shared strip — a path row for most kinds, the page pager for a PDF.

| filename | role | function |
|---|---|---|
| dock-tabs.ts | core | Generic tab container plus file/web tab identity, dedupe, eviction and body order |
| dock-tabs.test.ts | test | Tests container semantics, file dedupe, overflow eviction and body-order stability |
| dock-split.ts | core | Dock open flag, split band and divider drag arithmetic |
| dock-split.test.ts | test | Tests the width band, stored-value parsing and drag clamping |
| DockProvider.tsx | provider | Owns the tab list, open flag, split and host gating |
| DockPane.tsx | view | The fourth pane: strip, dock actions, divider and every tab body |
| DockPane.test.tsx | test | Tests body lifetime, per-tab isolation and mixed file/web switching |
| DockTabStrip.tsx | view | Sortable 50px strip labelling and chipping both kinds of tab |
| DockFileBody.tsx | view | Wraps a file tab's own bar around the DocViewer / media renderers |
| FileBar.tsx | view | A docked file's path row with its download and body-specific toggles |
