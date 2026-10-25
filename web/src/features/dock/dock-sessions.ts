import type { DockState, DockTab } from './dock-tabs';

// THE DOCK REMEMBERS PER SESSION. Each session keeps its own tabs, the tab it last showed and
// whether its dock is open, so switching sessions swaps the whole strip. PINNED tabs sit outside
// every session: they lead every session's strip and survive the switch.
//
// The strip operations in `dock-tabs.ts` stay unaware of either: a session's strip is composed as
// pinned + own (`stripOf`), the operation runs on that, and `editStrip` splits the result back —
// whatever was pinned stays pinned (so a drag can never interleave the two groups), the rest is the
// session's own.

export interface SessionDock {
  tabs: DockTab[];
  /** May name a pinned tab, or one that has since closed — `stripOf` falls back to the first. */
  activeId: string | null;
  open: boolean;
}

export interface DockStore {
  /** The session whose strip is on screen. */
  key: string;
  pinned: DockTab[];
  sessions: Readonly<Record<string, SessionDock>>;
}

export const EMPTY_DOCK_STORE: DockStore = { key: '', pinned: [], sessions: {} };

/** A session that never touched its dock starts closed — unless there are pinned tabs to show. */
function sessionOf(store: DockStore, key: string): SessionDock {
  return store.sessions[key] ?? { tabs: [], activeId: null, open: store.pinned.length > 0 };
}

function withSession(store: DockStore, key: string, session: SessionDock, pinned = store.pinned): DockStore {
  return { ...store, pinned, sessions: { ...store.sessions, [key]: session } };
}

export function switchSession(store: DockStore, key: string): DockStore {
  return key === store.key ? store : { ...store, key };
}

export function pinnedIdsOf(store: DockStore): ReadonlySet<string> {
  return new Set(store.pinned.map((tab) => tab.id));
}

/** A session's strip: pinned tabs first, then its own. Null when it has neither. */
export function stripOf(store: DockStore, key = store.key): DockState | null {
  const own = sessionOf(store, key);
  const tabs = [...store.pinned, ...own.tabs];
  if (tabs.length === 0) return null;
  const activeId = tabs.some((tab) => tab.id === own.activeId) ? own.activeId! : tabs[0]!.id;
  return { tabs, activeId };
}

export function isDockOpen(store: DockStore, key = store.key): boolean {
  return sessionOf(store, key).open;
}

/** Every tab in every session: all their bodies stay mounted, so a switch back loses nothing. */
export function allTabsOf(store: DockStore): DockTab[] {
  return [...store.pinned, ...Object.values(store.sessions).flatMap((session) => session.tabs)];
}

/** Run a strip operation on `key`'s strip and write it back; `open` also sets that dock's flag. */
export function editStrip(
  store: DockStore,
  key: string,
  edit: (strip: DockState | null) => DockState | null,
  open?: boolean,
): DockStore {
  const own = sessionOf(store, key);
  const before = stripOf(store, key);
  const after = edit(before);
  if (after === before && (open === undefined || open === own.open)) return store;
  const pinnedIds = pinnedIdsOf(store);
  const tabs = after?.tabs ?? [];
  const session: SessionDock = {
    tabs: tabs.filter((tab) => !pinnedIds.has(tab.id)),
    activeId: after?.activeId ?? null,
    open: open ?? own.open,
  };
  return withSession(store, key, session, tabs.filter((tab) => pinnedIds.has(tab.id)));
}

export function setDockOpen(store: DockStore, open: boolean): DockStore {
  return editStrip(store, store.key, (strip) => strip, open);
}

/** Pin one of the current session's own tabs: it moves to the end of the pinned group. */
export function pinTab(store: DockStore, id: string): DockStore {
  const own = sessionOf(store, store.key);
  const tab = own.tabs.find((candidate) => candidate.id === id);
  if (!tab) return store;
  const session = { ...own, tabs: own.tabs.filter((candidate) => candidate.id !== id) };
  return withSession(store, store.key, session, [...store.pinned, tab]);
}

/** Unpin into the current session, at the front of its own tabs; other sessions stop showing it. */
export function unpinTab(store: DockStore, id: string): DockStore {
  const tab = store.pinned.find((candidate) => candidate.id === id);
  if (!tab) return store;
  const own = sessionOf(store, store.key);
  const pinned = store.pinned.filter((candidate) => candidate.id !== id);
  return withSession(store, store.key, { ...own, tabs: [tab, ...own.tabs] }, pinned);
}

/** Update a tab wherever it lives: a hidden session's body still reports (titles, forwards). */
export function updateDockTab(store: DockStore, id: string, update: (tab: DockTab) => DockTab): DockStore {
  const apply = (tabs: DockTab[]) => tabs.map((tab) => (tab.id === id ? update(tab) : tab));
  if (store.pinned.some((tab) => tab.id === id)) return { ...store, pinned: apply(store.pinned) };
  const key = Object.keys(store.sessions).find((name) => store.sessions[name]!.tabs.some((tab) => tab.id === id));
  if (key === undefined) return store;
  const session = store.sessions[key]!;
  return withSession(store, key, { ...session, tabs: apply(session.tabs) });
}
