Please update me when files in this folder change.

The desktop three-pane page — and only that; the shared session core lives in
`features/session/` (49 files here). `WorkbenchPage.tsx` is the one route element; the panes
below it are this page's own chrome.

The layout is the load-bearing seam: a resizable `LeftRail` (flex:none; width persisted by
`rail/rail-width`) / fluid `CenterChat`
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

## rail/ — the left rail (resizable)

| filename | role | function |
|---|---|---|
| LeftRail.tsx | entry | The pane: project switcher, tree, banners. Also imported by memory/overview/skills |
| RailTree.tsx | core | The session/project tree body |
| rail-tree.ts | core | Pure tree model behind it |
| rail-order.ts | core | Ordering rules for rail rows |
| commission-rail.ts | core | The commission banner's rail state |
| ProjectFolderIcon.tsx | core | Per-project folder glyph |
| RunListModal.tsx | core | The run list opened from a rail row |
| RailResizeHandle.tsx | core | Drag/keyboard handle on the rail's edge; `rail-width.ts` clamps, parses and persists the width |
| `*.test.ts(x)` | test | vitest, colocated (rail-tree, rail-order, commission-rail, RailTree.commission, RailResizeHandle, rail-width) |

## chat/ — the centre pane

| filename | role | function |
|---|---|---|
| CenterChat.tsx | entry | The centre pane: header + the shared `features/session` transcript + composer |
| ChatHeader.tsx | core | Session title, project chip and compact icon actions (browser via `design/dock-intake`, notes, more menu) |
| InlineThreadCard.tsx | core | A thread card rendered inline in the transcript; `inline-thread-card-vm.ts` is its pure model |
| SessionIdModal.tsx | core | The session id / copy overlay |
| `*.test.ts(x)` | test | vitest, colocated (inline-thread-card-vm, optimistic-message.integration) |

## composer/ — the desktop composer chrome (18 files)

`Composer.tsx` is the entry; the rest is its chrome and the pieces it composes:
`ComposerActionRow`, `ComposerAttachmentChip`, `ComposerStatusLine`, `ComposerSendFailure`,
`DraftProjectSelector`, `SessionSelector` + `AgentMenu` (the agent chip's menu), `SelectionMenu`,
`SessionStatsModal`, `useFileDropTarget` + `ChatDropOverlay` (the drop cue spanning the whole chat
pane), plus colocated tests. Picker chrome comes from `design/MenuChrome`. The draft/slash/scope logic itself is not here —
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
