// input:  file preview items, browser tab state, and tab intents
// output: one ordered tab list mixing file previews with live web pages
// pos:    pure dock tab model; the container is generic over tab identity
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { browserTabLabel, type BrowserTabState } from '@/features/browser/browser-target';
import type { MediaItem } from '@/features/media/MediaViewer';
import type { DocItem } from '@/features/media/DocViewer';

// THE DOCK holds one ordered list of tabs, and a tab is either a docked FILE PREVIEW or a live WEB
// PAGE. That single list is what makes the pane's tab strip able to switch between the two without
// either side knowing about the other. The media item types are imported type-only (erased at build
// time) so the viewers can depend on the dock provider without a runtime cycle.

/** Anything the file previewers can render: image/video (MediaItem) or pdf/text/html (DocItem). */
export type FileItem = MediaItem | DocItem;

export interface FileDockTab {
  kind: 'file';
  id: string;
  item: FileItem;
  /** When this tab was last activated — the eviction order once MAX_DOCK_TABS is reached. */
  touchedAt: number;
}

/** A browser tab IS a dock tab: `BrowserTabState` already carries `kind: 'web'`, so the browser
 *  keeps owning its own per-tab model (history, draft, viewport, forward) unchanged. */
export type WebDockTab = BrowserTabState;

export type DockTab = FileDockTab | WebDockTab;

// ── Generic tab container ─────────────────────────────────────────────────────
// Add / select / reorder / close only ever touch `id` and `activeId`, so the container is generic
// and both kinds of tab flow through it untouched.

export interface TabsState<T extends { id: string }> {
  tabs: T[];
  activeId: string;
}

export type DockState = TabsState<DockTab>;

export function activeTabOf<T extends { id: string }>(state: TabsState<T>): T {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]!;
}

export function addTab<T extends { id: string }>(state: TabsState<T>, tab: T): TabsState<T> {
  return { tabs: [...state.tabs, tab], activeId: tab.id };
}

export function selectTab<T extends { id: string }>(state: TabsState<T>, id: string): TabsState<T> {
  if (id === state.activeId || !state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, activeId: id };
}

/** Reorder to an explicit permutation of the live ids; anything else is ignored, because a partial
 *  or duplicated order from a drag gesture must never be able to drop a tab. */
export function reorderTabs<T extends { id: string }>(state: TabsState<T>, orderedIds: string[]): TabsState<T> {
  const tabsById = new Map(state.tabs.map((tab) => [tab.id, tab]));
  const valid = orderedIds.length === state.tabs.length
    && new Set(orderedIds).size === orderedIds.length
    && orderedIds.every((id) => tabsById.has(id));
  if (!valid) return state;
  const tabs = orderedIds.map((id) => tabsById.get(id)!);
  if (tabs.every((tab, index) => tab === state.tabs[index])) return state;
  return { ...state, tabs };
}

export function updateTab<T extends { id: string }>(
  state: TabsState<T>,
  id: string,
  update: (tab: T) => T,
): TabsState<T> {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, tabs: state.tabs.map((tab) => (tab.id === id ? update(tab) : tab)) };
}

/** Close a tab, selecting its neighbour. `null` means the list is now EMPTY — the dock stays open
 *  on its empty hint rather than vanishing, so closing the last tab is not a surprise close. */
export function closeTab<T extends { id: string }>(state: TabsState<T>, id: string): TabsState<T> | null {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  if (state.tabs.length === 1) return null;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { ...state, tabs };
  return { tabs, activeId: tabs[Math.min(index, tabs.length - 1)]!.id };
}

// ── Dock tabs ─────────────────────────────────────────────────────────────────

/** Hard ceiling on docked tabs. Every tab body stays mounted (that is what keeps a PDF's page and a
 *  page's scroll position across a switch), so the list needs a ceiling to bound that cost. */
export const MAX_DOCK_TABS = 12;

export function isFileTab(tab: DockTab): tab is FileDockTab {
  return tab.kind === 'file';
}

export function isWebTab(tab: DockTab): tab is WebDockTab {
  return tab.kind === 'web';
}

/** pdf/text/html render through the DocViewer bodies; image/video render as media. */
export function isDocItem(item: FileItem): item is DocItem {
  return item.kind === 'pdf' || item.kind === 'text' || item.kind === 'html';
}

/**
 * A file tab's identity, or null when it has none.
 *
 * With no ephemeral "preview tab" concept, this is the ONLY thing stopping the same file from
 * opening twice — so it is load-bearing, not an optimisation. A composer item that is still just an
 * object URL for a not-yet-uploaded File has no stable identity and always opens a new tab.
 */
export function fileTabKey(item: FileItem): string | null {
  if (item.path) return `path:${item.path}`;
  const url = 'url' in item ? item.url : undefined;
  return url ? `url:${url}` : null;
}

/** The workspace path a docked tab can download, or null (a composer object URL has no workspace
 *  bytes yet, and a web page has none at all) — the pane hides its download action then. */
export function dockDownloadPath(tab: DockTab): string | null {
  return isFileTab(tab) ? tab.item.path ?? null : null;
}

export function dockTabLabel(tab: DockTab): string {
  return isFileTab(tab) ? tab.item.name : browserTabLabel(tab);
}

/** Mark a file tab as just-used, so eviction sheds the genuinely cold ones. */
export function touchTab(state: DockState, id: string, now: number): DockState {
  return updateTab(state, id, (tab) => (isFileTab(tab) ? { ...tab, touchedAt: now } : tab));
}

/**
 * Cap the tab count.
 *
 * Only FILE tabs are evicted: a web tab is something the user explicitly opened and its iframe holds
 * live page state that cannot be recreated, while a file tab re-fetches its bytes by path in one
 * click. The active tab is never a victim, and the coldest go first.
 */
export function evictOverflow(state: DockState): DockState {
  if (state.tabs.length <= MAX_DOCK_TABS) return state;
  const victims = state.tabs
    .filter((tab): tab is FileDockTab => isFileTab(tab) && tab.id !== state.activeId)
    .sort((a, b) => a.touchedAt - b.touchedAt);
  const drop = new Set<string>();
  for (const victim of victims) {
    if (state.tabs.length - drop.size <= MAX_DOCK_TABS) break;
    drop.add(victim.id);
  }
  if (drop.size === 0) return state;
  return { ...state, tabs: state.tabs.filter((tab) => !drop.has(tab.id)) };
}

/** Preview a file in the dock: focus the tab already holding it, else append and activate a new one. */
export function openFileTab(state: DockState | null, item: FileItem, id: string, now: number): DockState {
  const key = fileTabKey(item);
  if (state !== null && key !== null) {
    const existing = state.tabs.find((tab) => isFileTab(tab) && fileTabKey(tab.item) === key);
    if (existing) return touchTab(selectTab(state, existing.id), existing.id, now);
  }
  const tab: FileDockTab = { kind: 'file', id, item, touchedAt: now };
  if (state === null) return { tabs: [tab], activeId: id };
  return evictOverflow(addTab(state, tab));
}

/** Open a web tab: reuse an existing blank one (the address bar is the empty state, so a second
 *  blank tab would be indistinguishable clutter), else append a fresh one. */
export function openWebTab(state: DockState | null, tab: WebDockTab, isBlank: (tab: WebDockTab) => boolean): DockState {
  if (state === null) return { tabs: [tab], activeId: tab.id };
  const blank = state.tabs.find((candidate) => isWebTab(candidate) && isBlank(candidate));
  if (blank) return selectTab(state, blank.id);
  return evictOverflow(addTab(state, tab));
}

/**
 * Render order for the tab BODIES — insertion order, never the strip's display order.
 *
 * Reordering the strip must not re-parent a live iframe: React would tear the document down and
 * rebuild it, losing the page. So bodies keep a stable order of their own and only the chrome moves.
 */
export function syncBodyOrder(current: string[], tabs: DockTab[]): string[] {
  const liveIds = new Set(tabs.map((tab) => tab.id));
  const kept = current.filter((id) => liveIds.has(id));
  const known = new Set(kept);
  return [...kept, ...tabs.map((tab) => tab.id).filter((id) => !known.has(id))];
}
