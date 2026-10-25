import { describe, expect, it } from 'vitest';
import {
  EMPTY_DOCK_STORE,
  allTabsOf,
  editStrip,
  isDockOpen,
  pinTab,
  pinnedIdsOf,
  setDockOpen,
  stripOf,
  switchSession,
  unpinTab,
  updateDockTab,
  type DockStore,
} from './dock-sessions';
import { MAX_DOCK_TABS, closeTab, openBoardTab, openFileTab, reorderTabs, selectTab, type DockState } from './dock-tabs';

function open(store: DockStore, boardId: string, id: string, key = store.key): DockStore {
  return editStrip(store, key, (strip) => openBoardTab(strip, boardId, id, pinnedIdsOf(store)), true);
}

function ids(strip: DockState | null): string[] {
  return strip?.tabs.map((tab) => tab.id) ?? [];
}

const inA = switchSession(EMPTY_DOCK_STORE, 'a');

describe('per-session dock', () => {
  it('keeps each session\'s own tabs, active tab and open flag', () => {
    let store = open(open(inA, 'b1', 't1'), 'b2', 't2');
    store = editStrip(store, 'a', (strip) => selectTab(strip!, 't1'));
    store = switchSession(store, 'b');
    expect(stripOf(store)).toBeNull();
    expect(isDockOpen(store)).toBe(false);
    store = open(store, 'b3', 't3');
    store = switchSession(store, 'a');
    expect(ids(stripOf(store))).toEqual(['t1', 't2']);
    expect(stripOf(store)!.activeId).toBe('t1');
    expect(isDockOpen(store)).toBe(true);
  });

  it('remembers a closed dock per session', () => {
    let store = setDockOpen(open(inA, 'b1', 't1'), false);
    store = open(switchSession(store, 'b'), 'b2', 't2');
    expect(isDockOpen(store)).toBe(true);
    expect(isDockOpen(switchSession(store, 'a'))).toBe(false);
  });

  it('opens into a named session without switching to it', () => {
    const store = open(inA, 'b1', 't1', 'b');
    expect(stripOf(store)).toBeNull();
    expect(ids(stripOf(switchSession(store, 'b')))).toEqual(['t1']);
    expect(isDockOpen(switchSession(store, 'b'))).toBe(true);
  });

  it('lists every session\'s tabs for the mounted bodies', () => {
    const store = open(switchSession(open(inA, 'b1', 't1'), 'b'), 'b2', 't2');
    expect(allTabsOf(store).map((tab) => tab.id).sort()).toEqual(['t1', 't2']);
  });

  it('updates a tab wherever it lives, so a hidden session\'s body can still report', () => {
    const store = switchSession(open(inA, 'b1', 't1'), 'b');
    const next = updateDockTab(store, 't1', (tab) => (tab.kind === 'board' ? { ...tab, boardId: 'b9' } : tab));
    const tab = stripOf(switchSession(next, 'a'))!.tabs[0]!;
    expect(tab.kind === 'board' && tab.boardId).toBe('b9');
  });
});

describe('pinned tabs', () => {
  it('shows a pinned tab first in every session', () => {
    let store = pinTab(open(open(inA, 'b1', 't1'), 'b2', 't2'), 't2');
    expect(ids(stripOf(store))).toEqual(['t2', 't1']);
    store = switchSession(store, 'b');
    expect(ids(stripOf(store))).toEqual(['t2']);
    expect(isDockOpen(store)).toBe(true);
  });

  it('focuses the pinned tab instead of opening a duplicate', () => {
    let store = switchSession(pinTab(open(inA, 'b1', 't1'), 't1'), 'b');
    store = open(store, 'b1', 't9');
    expect(ids(stripOf(store))).toEqual(['t1']);
  });

  it('unpins into the current session only', () => {
    let store = switchSession(pinTab(open(inA, 'b1', 't1'), 't1'), 'b');
    store = unpinTab(open(store, 'b2', 't2'), 't1');
    expect(ids(stripOf(store))).toEqual(['t1', 't2']);
    expect(stripOf(switchSession(store, 'a'))).toBeNull();
  });

  it('closing a pinned tab removes it everywhere and other sessions fall back', () => {
    let store = pinTab(open(open(inA, 'b1', 't1'), 'b2', 't2'), 't1');
    store = editStrip(store, 'a', (strip) => selectTab(strip!, 't1'));
    store = open(switchSession(store, 'b'), 'b3', 't3');
    store = editStrip(store, 'b', (strip) => closeTab(strip!, 't1'));
    expect(ids(stripOf(store))).toEqual(['t3']);
    expect(stripOf(switchSession(store, 'a'))!.activeId).toBe('t2');
  });

  it('keeps pinned tabs ahead of the rest when a drag crosses the boundary', () => {
    let store = pinTab(open(open(inA, 'b1', 't1'), 'b2', 't2'), 't1');
    store = editStrip(store, 'a', (strip) => reorderTabs(strip!, ['t2', 't1']));
    expect(ids(stripOf(store))).toEqual(['t1', 't2']);
  });

  it('never evicts a pinned file tab', () => {
    const file = (i: number) => ({ kind: 'text' as const, name: `f${i}.md`, path: `workspace/f${i}.md` });
    let store = editStrip(inA, 'a', (strip) => openFileTab(strip, file(0), 'pin', 0), true);
    store = pinTab(store, 'pin');
    for (let i = 1; i <= MAX_DOCK_TABS + 2; i += 1) {
      const keep = pinnedIdsOf(store);
      store = editStrip(store, 'a', (strip) => openFileTab(strip, file(i), `f${i}`, i, keep), true);
    }
    expect(ids(stripOf(store))).toContain('pin');
    expect(stripOf(store)!.tabs).toHaveLength(MAX_DOCK_TABS);
  });
});
