// input:  dock tab intents over file items and browser tabs
// output: regressions for tab identity, dedupe, eviction and body order
// pos:    Unit tests for the dock tab model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<
import { describe, it, expect } from 'vitest';
import { createBrowserTab, isBlankWebTab, pushHistory } from '@/features/browser/browser-target';
import {
  MAX_DOCK_TABS,
  activeTabOf,
  addTab,
  closeTab,
  dockDownloadPath,
  dockTabLabel,
  evictOverflow,
  fileTabKey,
  isDocItem,
  openFileTab,
  openWebTab,
  reorderTabs,
  selectTab,
  syncBodyOrder,
  updateTab,
  type DockState,
  type FileItem,
} from './dock-tabs';

const img: FileItem = { kind: 'image', name: 'shot.png', path: 'workspace/shot.png' };
const localImg: FileItem = { kind: 'image', name: 'local.png', url: 'blob:local' };
const staged: FileItem = { kind: 'image', name: 'staged.png' };
const pdf: FileItem = { kind: 'pdf', name: 'paper.pdf', path: 'workspace/paper.pdf' };

function web(id: string, url?: string): ReturnType<typeof createBrowserTab> {
  const tab = createBrowserTab(id);
  return url === undefined ? tab : { ...tab, history: pushHistory(tab.history, url) };
}

function files(count: number, start = 0): DockState {
  let state: DockState | null = null;
  for (let i = start; i < start + count; i += 1) {
    state = openFileTab(state, { kind: 'text', name: `f${i}.md`, path: `workspace/f${i}.md` }, `file-${i}`, i);
  }
  return state!;
}

describe('generic tab container', () => {
  it('adds a tab and makes it active', () => {
    const state = addTab({ tabs: [web('a')], activeId: 'a' }, web('b'));
    expect(state.activeId).toBe('b');
    expect(state.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
  });

  it('selects tabs without changing their contents', () => {
    const original = addTab({ tabs: [web('a')], activeId: 'a' }, web('b'));
    const selected = selectTab(original, 'a');
    expect(selected.activeId).toBe('a');
    expect(selected.tabs).toBe(original.tabs);
    expect(selectTab(original, 'missing')).toBe(original);
  });

  it('reorders tabs without changing active or per-tab state', () => {
    let state = addTab({ tabs: [web('a')], activeId: 'a' }, web('b'));
    state = addTab(state, web('c'));
    const originalTabs = [...state.tabs];

    const reordered = reorderTabs(state, ['c', 'a', 'b']);

    expect(reordered.activeId).toBe('c');
    expect(reordered.tabs.map((tab) => tab.id)).toEqual(['c', 'a', 'b']);
    expect(reordered.tabs[0]).toBe(originalTabs[2]);
  });

  it('ignores invalid reorder permutations rather than dropping a tab', () => {
    const state = addTab({ tabs: [web('a')], activeId: 'a' }, web('b'));
    expect(reorderTabs(state, ['a'])).toBe(state);
    expect(reorderTabs(state, ['a', 'a'])).toBe(state);
    expect(reorderTabs(state, ['a', 'c'])).toBe(state);
  });

  it('updates one tab in place', () => {
    const state = addTab({ tabs: [web('a')], activeId: 'a' }, web('b'));
    const next = updateTab(state, 'a', (tab) => ({ ...tab, draft: 'typed' }));
    expect(next.tabs[0]!.draft).toBe('typed');
    expect(next.tabs[1]).toBe(state.tabs[1]);
    expect(updateTab(state, 'missing', (tab) => tab)).toBe(state);
  });

  it('selects an adjacent tab on close, and reports an empty list as null', () => {
    let state: DockState | null = addTab({ tabs: [web('a')], activeId: 'a' }, web('b'));
    state = addTab(state, web('c'));
    state = selectTab(state, 'b');
    state = closeTab(state, 'b');
    expect(state!.activeId).toBe('c');
    expect(state!.tabs.map((tab) => tab.id)).toEqual(['a', 'c']);

    state = closeTab(state!, 'a');
    expect(state!.tabs.map((tab) => tab.id)).toEqual(['c']);
    expect(closeTab(state!, 'c')).toBeNull();
  });
});

describe('file tab identity', () => {
  it('keys a file by its workspace path, else its object URL', () => {
    expect(fileTabKey(img)).toBe('path:workspace/shot.png');
    expect(fileTabKey(localImg)).toBe('url:blob:local');
  });

  it('has no key for a staged file with neither — it can only ever open a new tab', () => {
    expect(fileTabKey(staged)).toBeNull();
  });

  it('focuses the tab already holding a file instead of opening a second one', () => {
    let state = openFileTab(null, img, 'file-0', 1);
    state = openFileTab(state, pdf, 'file-1', 2);
    expect(state.activeId).toBe('file-1');

    state = openFileTab(state, { ...img }, 'file-2', 3);
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe('file-0');
  });

  it('opens a new tab every time for a file with no stable identity', () => {
    let state = openFileTab(null, staged, 'file-0', 1);
    state = openFileTab(state, staged, 'file-1', 2);
    expect(state.tabs.map((tab) => tab.id)).toEqual(['file-0', 'file-1']);
  });

  it('labels a file tab by name and a web tab by its address', () => {
    const state = openFileTab(null, pdf, 'file-0', 1);
    expect(dockTabLabel(state.tabs[0]!)).toBe('paper.pdf');
    expect(dockTabLabel(web('a', 'http://127.0.0.1:5173/'))).toBe('127.0.0.1');
  });

  it('offers a download only for a file that has workspace bytes', () => {
    expect(dockDownloadPath(openFileTab(null, pdf, 'f', 1).tabs[0]!)).toBe('workspace/paper.pdf');
    expect(dockDownloadPath(openFileTab(null, localImg, 'f', 1).tabs[0]!)).toBeNull();
    expect(dockDownloadPath(web('a', 'http://127.0.0.1:5173/'))).toBeNull();
  });

  it('routes pdf/text/html through the document bodies and image/video through media', () => {
    expect(isDocItem(pdf)).toBe(true);
    expect(isDocItem({ kind: 'text', name: 'a.md', path: 'workspace/a.md' })).toBe(true);
    expect(isDocItem(img)).toBe(false);
    expect(isDocItem({ kind: 'video', name: 'v.mp4', path: 'workspace/v.mp4' })).toBe(false);
  });
});

describe('overflow eviction', () => {
  it('keeps the list at the cap by shedding the coldest file tabs', () => {
    const state = files(MAX_DOCK_TABS + 3);
    expect(state.tabs).toHaveLength(MAX_DOCK_TABS);
    expect(state.tabs[0]!.id).toBe('file-3');
    expect(state.activeId).toBe(`file-${MAX_DOCK_TABS + 2}`);
  });

  it('never evicts a web tab, even when it is the coldest thing in the list', () => {
    let state: DockState | null = { tabs: [web('keep-me')], activeId: 'keep-me' };
    for (let i = 0; i < MAX_DOCK_TABS + 2; i += 1) {
      state = openFileTab(state, { kind: 'text', name: `f${i}.md`, path: `workspace/f${i}.md` }, `file-${i}`, i);
    }
    expect(state!.tabs.some((tab) => tab.id === 'keep-me')).toBe(true);
    expect(state!.tabs).toHaveLength(MAX_DOCK_TABS);
  });

  it('never evicts the active tab, even when it is the coldest', () => {
    const tabs = Array.from({ length: MAX_DOCK_TABS + 2 }, (_, i) => ({
      kind: 'file' as const, id: `file-${i}`, item: pdf, touchedAt: i,
    }));
    const state = evictOverflow({ tabs, activeId: 'file-0' });
    expect(state.tabs.some((tab) => tab.id === 'file-0')).toBe(true);
    expect(state.tabs).toHaveLength(MAX_DOCK_TABS);
  });

  it('leaves a list at the cap untouched', () => {
    const state = files(MAX_DOCK_TABS);
    expect(evictOverflow(state)).toBe(state);
  });
});

describe('web tabs in the dock', () => {
  it('reuses a blank web tab rather than stacking indistinguishable empties', () => {
    const first = openWebTab(null, web('browser-0'), isBlankWebTab);
    const second = openWebTab(first, web('browser-1'), isBlankWebTab);
    expect(second.tabs.map((tab) => tab.id)).toEqual(['browser-0']);
    expect(second.activeId).toBe('browser-0');
  });

  it('appends a new tab once the existing ones have navigated', () => {
    const navigated: DockState = { tabs: [web('browser-0', 'http://127.0.0.1:5173/')], activeId: 'browser-0' };
    const state = openWebTab(navigated, web('browser-1'), isBlankWebTab);
    expect(state.tabs.map((tab) => tab.id)).toEqual(['browser-0', 'browser-1']);
    expect(state.activeId).toBe('browser-1');
  });

  it('mixes file and web tabs in one list', () => {
    let state: DockState | null = openFileTab(null, pdf, 'file-0', 1);
    state = openWebTab(state, web('browser-0'), isBlankWebTab);
    state = openFileTab(state, img, 'file-1', 2);
    expect(state.tabs.map((tab) => tab.kind)).toEqual(['file', 'web', 'file']);
    expect(activeTabOf(state).id).toBe('file-1');
  });
});

describe('syncBodyOrder', () => {
  it('appends new tabs and drops closed ones without disturbing the survivors', () => {
    const tabs = [web('a'), web('b'), web('c')];
    expect(syncBodyOrder([], tabs)).toEqual(['a', 'b', 'c']);
    expect(syncBodyOrder(['a', 'b'], tabs)).toEqual(['a', 'b', 'c']);
    expect(syncBodyOrder(['a', 'b', 'c'], [tabs[2]!, tabs[0]!])).toEqual(['a', 'c']);
  });

  it('ignores the strip order, so dragging a tab never re-parents its live body', () => {
    const tabs = [web('a'), web('b'), web('c')];
    const order = syncBodyOrder([], tabs);
    expect(syncBodyOrder(order, [tabs[2]!, tabs[1]!, tabs[0]!])).toEqual(['a', 'b', 'c']);
  });
});
