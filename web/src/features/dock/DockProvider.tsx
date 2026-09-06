// input:  file preview items, web tab intents and divider drags
// output: the dock's tab list, open flag and split share
// pos:    Dock state owner; holds no viewer or browser imports
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createBrowserTab, isBlankWebTab } from '@/features/browser/browser-target';
import {
  clampDockSplit,
  DOCK_OPEN_KEY,
  DOCK_SPLIT_DEFAULT,
  DOCK_SPLIT_KEY,
  parseDockOpen,
  parseDockSplit,
} from './dock-split';
import {
  activeTabOf,
  closeTab,
  openFileTab,
  openWebTab,
  reorderTabs,
  selectTab,
  touchTab,
  updateTab,
  type DockState,
  type DockTab,
  type FileItem,
  type WebDockTab,
} from './dock-tabs';

// THE DOCK — the workbench's fourth pane, and the docked alternative to the full-screen preview
// modals. It holds ONE tab strip whose tabs are either file previews or live web pages.
//
// Default mode: clicking a previewable image / video / document raises the MediaViewer lightbox or
// the DocViewer modal. Pressing the modal's ◧ button OPENS THE DOCK, and from then on every preview
// click opens (or focuses) a tab instead of raising a modal. The strip's × closes the dock and
// restores modal mode — the tabs stay mounted and hidden, so reopening resumes exactly where it was.
//
// `canDock` / `active` are gated on a mounted host (`DockPane`, rendered only by the desktop
// workbench frame) — so the ◧ button never appears, and the dock never swallows a preview, on a
// surface that has nowhere to put it (mobile shell, thread detail route, …).
// This module imports no viewer component, so MediaViewer / DocViewer can consume it without a cycle.

interface DockContextValue {
  /** A host is mounted → previews CAN be docked (the modals show their ◧ button). */
  canDock: boolean;
  /** The dock is open AND a host is mounted → openMedia / openDoc route to a tab. */
  active: boolean;
  /** The open flag itself (persisted); the pane is visible whenever this is on. */
  open: boolean;
  /** The tab list, or null when the dock has no tabs (it then shows its empty hint). */
  state: DockState | null;
  activeTab: DockTab | null;
  /** The dock pane's share of the center region (chat + dock). */
  split: number;
  /** Preview a file: opens the dock, and focuses its tab if that file is already open. */
  openFile: (item: FileItem) => void;
  /** Opens the dock on a web tab, reusing a blank one when there is one. */
  openWeb: () => void;
  select: (id: string) => void;
  close: (id: string) => void;
  reorder: (orderedIds: string[]) => void;
  /** A web tab's body drives its own state (navigation, drafts, forwards) through this. */
  updateWeb: (id: string, update: (tab: WebDockTab) => WebDockTab) => void;
  /** Hide the dock and restore modal previews; the tabs survive for the next open. */
  closeDock: () => void;
  /** Live during a divider drag; `persist` on drag end. */
  setSplit: (value: number, persist?: boolean) => void;
  /** Mounted by the pane; returns the unregister callback. */
  registerHost: () => () => void;
}

// No provider in scope (mobile shell, isolated component tests) → inert: nothing can dock, so both
// viewers keep their modal behavior unchanged.
const DockContext = createContext<DockContextValue>({
  canDock: false,
  active: false,
  open: false,
  state: null,
  activeTab: null,
  split: DOCK_SPLIT_DEFAULT,
  openFile: () => {},
  openWeb: () => {},
  select: () => {},
  close: () => {},
  reorder: () => {},
  updateWeb: () => {},
  closeDock: () => {},
  setSplit: () => {},
  registerHost: () => () => {},
});

function initialOpen(): boolean {
  try {
    return parseDockOpen(window.localStorage.getItem(DOCK_OPEN_KEY));
  } catch {
    return false;
  }
}

function initialSplit(): number {
  try {
    return parseDockSplit(window.localStorage.getItem(DOCK_SPLIT_KEY));
  } catch {
    return DOCK_SPLIT_DEFAULT;
  }
}

function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* persistence is best-effort (SSR / private mode) */
  }
}

export function DockProvider({ children }: { children: ReactNode }): JSX.Element {
  const [open, setOpen] = useState(initialOpen);
  const [state, setState] = useState<DockState | null>(null);
  const [split, setSplitState] = useState(initialSplit);
  const [hosts, setHosts] = useState(0);
  const nextId = useRef(0);

  const registerHost = useCallback(() => {
    setHosts((n) => n + 1);
    return () => setHosts((n) => Math.max(0, n - 1));
  }, []);

  const show = useCallback(() => {
    setOpen(true);
    store(DOCK_OPEN_KEY, '1');
  }, []);

  // Ids are minted OUTSIDE the state updater: an updater may run twice (StrictMode) and a tab whose
  // identity changed between runs would remount its body.
  const mintId = useCallback((prefix: string) => `${prefix}-${nextId.current++}`, []);

  const openFile = useCallback((item: FileItem) => {
    show();
    const id = mintId('dock-file');
    setState((current) => openFileTab(current, item, id, Date.now()));
  }, [mintId, show]);

  const openWeb = useCallback(() => {
    show();
    const tab = createBrowserTab(mintId('browser-tab'));
    setState((current) => openWebTab(current, tab, isBlankWebTab));
  }, [mintId, show]);

  const select = useCallback((id: string) => {
    setState((current) => (current === null ? current : touchTab(selectTab(current, id), id, Date.now())));
  }, []);

  const close = useCallback((id: string) => {
    setState((current) => (current === null ? current : closeTab(current, id)));
  }, []);

  const reorder = useCallback((orderedIds: string[]) => {
    setState((current) => (current === null ? current : reorderTabs(current, orderedIds)));
  }, []);

  const updateWeb = useCallback((id: string, update: (tab: WebDockTab) => WebDockTab) => {
    setState((current) => (current === null ? current
      : updateTab(current, id, (tab) => (tab.kind === 'web' ? update(tab) : tab))));
  }, []);

  const closeDock = useCallback(() => {
    setOpen(false);
    store(DOCK_OPEN_KEY, '0');
  }, []);

  const setSplit = useCallback((value: number, persist = false) => {
    const next = clampDockSplit(value);
    setSplitState(next);
    if (persist) store(DOCK_SPLIT_KEY, String(next));
  }, []);

  const value = useMemo<DockContextValue>(
    () => ({
      canDock: hosts > 0,
      active: open && hosts > 0,
      open,
      state,
      activeTab: state === null ? null : activeTabOf(state),
      split,
      openFile,
      openWeb,
      select,
      close,
      reorder,
      updateWeb,
      closeDock,
      setSplit,
      registerHost,
    }),
    [hosts, open, state, split, openFile, openWeb, select, close, reorder, updateWeb, closeDock, setSplit, registerHost],
  );

  return <DockContext.Provider value={value}>{children}</DockContext.Provider>;
}

export function useDock(): DockContextValue {
  return useContext(DockContext);
}
