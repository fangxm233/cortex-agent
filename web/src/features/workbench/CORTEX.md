Please update me when files in this folder change.

The desktop three-pane page — and only that, since step 2 moved the shared session core to
`features/session/` (42 files). `WorkbenchPage.tsx` is the one route element; the panes
below it are this page's own chrome.

The layout is the load-bearing seam: 340px `LeftRail` (flex:none) / fluid `CenterChat`
(flex:1;min-width:0) / 400px `RightPanel` (flex:none), inside `shell/AppFrame`. When the
dock is open, `DockPane` becomes a fourth pane and the fluid centre is split chat | dock.
This page is the dock's host, which is why the modals' ◧ button appears on this route only.

**The rails are imported outward, one-directionally.** `features/memory/MemoryPage.tsx`,
`features/overview/OverviewPage.tsx` and `features/skills/SkillsPage.tsx` each import
`workbench/rail/LeftRail` and `workbench/right-panel/RightPanel` to frame themselves.
Workbench imports nothing back from those three, so no cycle exists and none is allow-listed
— but moving or renaming either rail changes four pages, not one.

| filename | role | function |
|---|---|---|
| WorkbenchPage.tsx | entry | The route element: the flex row, the dock split, the settings opener |
| WorkbenchModals.test.tsx | test | Asserts the page's overlays come off the shared modal registry |

## rail/ — the left rail (340px)

| filename | role | function |
|---|---|---|
| LeftRail.tsx | entry | The pane: project switcher, tree, banners. Also imported by memory/overview/skills |
| RailTree.tsx | core | The session/project tree body |
| rail-tree.ts | core | Pure tree model behind it |
| rail-order.ts | core | Ordering rules for rail rows |
| commission-rail.ts | core | The commission banner's rail state |
| ProjectFolderIcon.tsx | core | Per-project folder glyph |
| RunListModal.tsx | core | The run list opened from a rail row |
| `*.test.ts(x)` | test | vitest, colocated (rail-tree, rail-order, commission-rail, RailTree.commission) |

## chat/ — the centre pane

| filename | role | function |
|---|---|---|
| CenterChat.tsx | entry | The centre pane: header + the shared `features/session` transcript + composer |
| ChatHeader.tsx | core | Session title, status, per-session actions |
| InlineThreadCard.tsx | core | A thread card rendered inline in the transcript; `inline-thread-card-vm.ts` is its pure model |
| SessionIdModal.tsx | core | The session id / copy overlay |
| `*.test.ts(x)` | test | vitest, colocated (inline-thread-card-vm, optimistic-message.integration) |

## composer/ — the desktop composer chrome (15 files)

`Composer.tsx` is the entry; the rest is its chrome and the pieces it composes:
`ComposerActionRow`, `ComposerAttachmentChip`, `ComposerStatusLine`, `ComposerSendFailure`,
`DraftProjectSelector`, `SessionSelector`, `SelectionMenu`, `SessionStatsModal`,
`useFileDropTarget`, plus colocated tests. The draft/slash/scope logic itself is not here —
it lives in `features/session/composer/`, shared with mobile.

## right-panel/ — the right pane (400px)

| filename | role | function |
|---|---|---|
| RightPanel.tsx | entry | The pane and its tabs. Also imported by memory/overview/skills |
| right-panel-vm.ts | core | Pure model for the panel's tabs and cost bar |
| RightThreadCard.tsx | core | A thread row in the panel; opens the execution drawer |
| RightMachinesTab.tsx | core | The machines tab body |
| PaneToggle.tsx | core | Collapse/expand control, driven by `shell/PaneStateProvider` |
| `*.test.ts(x)` | test | vitest, colocated (right-panel-vm, RightThreadCard) |
