import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction,
} from 'react';
import { DockIntakeProvider, type DockIntakeValue } from '@/design/dock-intake';
import {
  createBrowserTab,
  deviceForwardsInUse,
  isBlankWebTab,
  type DeviceForward,
} from '@/features/browser/browser-target';
import { closeDeviceForward } from '@/features/browser/forward';
import { clampDockSplit, DOCK_SPLIT_DEFAULT, DOCK_SPLIT_KEY, parseDockSplit } from './dock-split';
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
import {
  activeTabOf,
  closeTab,
  isWebTab,
  openAgentBrowserTab,
  openBoardTab,
  openFileTab,
  openWebTab,
  reorderTabs,
  selectTab,
  touchTab,
  type DockState,
  type DockTab,
  type FileItem,
  type WebDockTab,
} from './dock-tabs';

// THE DOCK — the workbench's fourth pane, and the docked alternative to the full-screen preview
// modals. It shows ONE tab strip of file previews, web pages, boards and agent browsers — the
// strip of the selected session (`dock-sessions.ts`): each session keeps its own tabs and its own
// open flag, and pinned tabs lead every session's strip. AppShell feeds the selected session in.
//
// Default mode: clicking a previewable image / video / document raises the MediaViewer lightbox or
// the DocViewer modal. Pressing the modal's ◧ button OPENS THE DOCK, and from then on every preview
// click in that session opens (or focuses) a tab instead of raising a modal. The strip's × closes
// the dock and restores modal mode — the tabs stay mounted and hidden, so reopening resumes exactly
// where it was.
//
// `canDock` / `active` are gated on a mounted host (`DockPane`, rendered only by the desktop
// workbench frame) — so the ◧ button never appears, and the dock never swallows a preview, on a
// surface that has nowhere to put it (mobile shell, thread detail route, …).
//
// `useDock()` is for the dock's own chrome and its host (DockPane, WorkbenchView, the View menu).
// Everything that opens INTO the dock — the two preview modals, the Web button, an agent view card
// — goes through `design/dock-intake`, which this provider also supplies: those surfaces live in
// features the dock renders bodies from, so pointing them at `features/dock` is what used to make
// the dependency mutual.

/** What the dock does; every member is a stable callback. */
interface DockActions {
  /** Preview a file: opens the dock, and focuses its tab if that file is already open. */
  openFile: (item: FileItem) => void;
  /** Opens the dock on a web tab, reusing a blank one when there is one. */
  openWeb: () => void;
  /** Opens the dock on a board, focusing its tab when it is already open. `inSession` targets
   *  that session's strip instead of the selected one — for a caller that is switching to it. */
  openBoard: (boardId: string, inSession?: string) => void;
  /** Opens the dock on a session's agent browser, focusing its tab when it is already open. */
  openAgentBrowser: (sessionId: string, inSession?: string) => void;
  select: (id: string) => void;
  close: (id: string) => void;
  reorder: (orderedIds: string[]) => void;
  /** A web tab's body drives its own state (navigation, drafts, forwards) through this. */
  updateWeb: (id: string, update: (tab: WebDockTab) => WebDockTab) => void;
  /** Pin one of the session's own tabs, so every session's strip shows it. */
  pin: (id: string) => void;
  /** Return a pinned tab to the selected session alone. */
  unpin: (id: string) => void;
  /** Show the strip of this session (the selected session's id). */
  setSession: (key: string) => void;
  /** Hide the dock and restore modal previews; the tabs survive for the next open. */
  closeDock: () => void;
  /** Show/hide the dock from a window-level surface (top bar View menu). Reopens the surviving
   *  tabs when there are any, and falls back to a fresh web tab when the strip is empty —
   *  otherwise the menu item would toggle a pane with nothing in it. */
  toggleDock: () => void;
}

interface DockContextValue extends DockActions {
  /** A host is mounted → previews CAN be docked (the modals show their ◧ button). */
  canDock: boolean;
  /** The dock is open AND a host is mounted → openMedia / openDoc route to a tab. */
  active: boolean;
  /** The selected session's open flag; the pane is visible whenever this is on. */
  open: boolean;
  /** The session whose strip is on screen (its id; '' before any selection). */
  sessionKey: string;
  /** The selected session's strip, or null when it has no tabs (it then shows its empty hint). */
  state: DockState | null;
  activeTab: DockTab | null;
  /** Every session's tabs: the pane keeps all their bodies mounted. */
  allTabs: DockTab[];
  pinnedIds: ReadonlySet<string>;
  /** The dock pane's share of the center region (chat + dock). */
  split: number;
  /** Live during a divider drag; `persist` on drag end. */
  setSplit: (value: number, persist?: boolean) => void;
  /** Mounted by the pane; returns the unregister callback. */
  registerHost: () => () => void;
}

const noop = () => {};

// No provider in scope (mobile shell, isolated component tests) → inert: nothing can dock, so both
// viewers keep their modal behavior unchanged.
const DockContext = createContext<DockContextValue>({
  canDock: false,
  active: false,
  open: false,
  sessionKey: '',
  state: null,
  activeTab: null,
  allTabs: [],
  pinnedIds: new Set(),
  split: DOCK_SPLIT_DEFAULT,
  openFile: noop,
  openWeb: noop,
  openBoard: noop,
  openAgentBrowser: noop,
  select: noop,
  close: noop,
  reorder: noop,
  updateWeb: noop,
  pin: noop,
  unpin: noop,
  setSession: noop,
  closeDock: noop,
  toggleDock: noop,
  setSplit: noop,
  registerHost: () => noop,
});

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

type SetStore = Dispatch<SetStateAction<DockStore>>;
type StripEdit = (strip: DockState | null) => DockState | null;
type StripOpen = (strip: DockState | null, keep: ReadonlySet<string>) => DockState;

/** Edit the selected strip; `openInto` also opens the target session's dock. Pinned tabs are
 *  passed as `keep`, so an open that overflows the cap never evicts one. */
function stripEditors(setStore: SetStore) {
  const edit = (fn: StripEdit) => setStore((current) => editStrip(current, current.key, fn));
  const openInto = (key: string | undefined, fn: StripOpen) => setStore((current) =>
    editStrip(current, key ?? current.key, (strip) => fn(strip, pinnedIdsOf(current)), true));
  return { edit, openInto };
}

// Ids are minted OUTSIDE the state updaters: an updater may run twice (StrictMode) and a tab whose
// identity changed between runs would remount its body.
function openActions(setStore: SetStore, mintId: (prefix: string) => string) {
  const { openInto } = stripEditors(setStore);
  return {
    openFile: (item: FileItem) => {
      const id = mintId('dock-file');
      openInto(undefined, (strip, keep) => openFileTab(strip, item, id, Date.now(), keep));
    },
    openWeb: () => {
      const tab = createBrowserTab(mintId('browser-tab'));
      openInto(undefined, (strip, keep) => openWebTab(strip, tab, isBlankWebTab, keep));
    },
    openBoard: (boardId: string, inSession?: string) => {
      const id = mintId('dock-board');
      openInto(inSession, (strip, keep) => openBoardTab(strip, boardId, id, keep));
    },
    openAgentBrowser: (sessionId: string, inSession?: string) => {
      const id = mintId('dock-agent-browser');
      openInto(inSession, (strip, keep) => openAgentBrowserTab(strip, sessionId, id, keep));
    },
  };
}

function stripActions(setStore: SetStore) {
  const { edit } = stripEditors(setStore);
  return {
    select: (id: string) => edit((strip) => (strip === null ? strip : touchTab(selectTab(strip, id), id, Date.now()))),
    close: (id: string) => edit((strip) => (strip === null ? strip : closeTab(strip, id))),
    reorder: (orderedIds: string[]) => edit((strip) => (strip === null ? strip : reorderTabs(strip, orderedIds))),
    updateWeb: (id: string, update: (tab: WebDockTab) => WebDockTab) => setStore((current) =>
      updateDockTab(current, id, (tab) => (tab.kind === 'web' ? update(tab) : tab))),
    pin: (id: string) => setStore((current) => pinTab(current, id)),
    unpin: (id: string) => setStore((current) => unpinTab(current, id)),
    setSession: (key: string) => setStore((current) => switchSession(current, key)),
    closeDock: () => setStore((current) => setDockOpen(current, false)),
  };
}

function toggled(current: DockStore, blank: WebDockTab): DockStore {
  if (isDockOpen(current)) return setDockOpen(current, false);
  if (stripOf(current) !== null) return setDockOpen(current, true);
  return editStrip(current, current.key, (strip) => openWebTab(strip, blank, isBlankWebTab), true);
}

function useDockActions(setStore: SetStore): DockActions {
  const nextId = useRef(0);
  return useMemo(() => {
    const mintId = (prefix: string) => `${prefix}-${nextId.current++}`;
    const toggleDock = () => {
      const blank = createBrowserTab(mintId('browser-tab'));
      setStore((current) => toggled(current, blank));
    };
    return { ...openActions(setStore, mintId), ...stripActions(setStore), toggleDock };
  }, [setStore]);
}

// A device port mapping outlives the tab that asked for it unless someone closes it: release each
// one as soon as no tab in any session shows it (tab closed, evicted, or its forward replaced).
// Hiding the dock or switching sessions keeps the tabs alive, so it keeps their mappings too.
function useReleaseDeviceForwards(allTabs: DockTab[]): void {
  const deviceForwards = useRef(new Map<string, DeviceForward>());
  useEffect(() => {
    const inUse = deviceForwardsInUse(allTabs.filter(isWebTab));
    for (const [key, { device, port }] of deviceForwards.current) {
      if (!inUse.has(key)) void closeDeviceForward(device, port).catch(() => {});
    }
    deviceForwards.current = inUse;
  }, [allTabs]);
}

function useSplit(): [number, (value: number, persist?: boolean) => void] {
  const [split, setSplitState] = useState(initialSplit);
  const setSplit = useCallback((value: number, persist = false) => {
    const next = clampDockSplit(value);
    setSplitState(next);
    if (persist) store(DOCK_SPLIT_KEY, String(next));
  }, []);
  return [split, setSplit];
}

function useHosts(): [number, () => () => void] {
  const [hosts, setHosts] = useState(0);
  const registerHost = useCallback(() => {
    setHosts((n) => n + 1);
    return () => setHosts((n) => Math.max(0, n - 1));
  }, []);
  return [hosts, registerHost];
}

// The narrow surface, memoised on its own members: a divider drag changes `split` sixty times a
// second and must not re-render the preview modals, which do not read it.
function useIntake(value: DockContextValue): DockIntakeValue {
  const { canDock, active, activeTab, openFile, openWeb, openBoard, openAgentBrowser } = value;
  return useMemo<DockIntakeValue>(
    () => ({
      canDock,
      active,
      activeKind: activeTab?.kind ?? null,
      activeBoardId: activeTab?.kind === 'board' ? activeTab.boardId : null,
      activeAgentBrowserSession: activeTab?.kind === 'agent-browser' ? activeTab.sessionId : null,
      openFile,
      openWeb,
      openBoard,
      openAgentBrowser,
    }),
    [canDock, active, activeTab, openFile, openWeb, openBoard, openAgentBrowser],
  );
}

function useDockValue(dockStore: DockStore, actions: DockActions): DockContextValue {
  const [split, setSplit] = useSplit();
  const [hosts, registerHost] = useHosts();
  const state = useMemo(() => stripOf(dockStore), [dockStore]);
  const allTabs = useMemo(() => allTabsOf(dockStore), [dockStore]);
  const pinned = dockStore.pinned;
  const pinnedIds = useMemo(() => new Set(pinned.map((tab) => tab.id)), [pinned]);
  const open = isDockOpen(dockStore);
  useReleaseDeviceForwards(allTabs);
  return useMemo<DockContextValue>(() => ({
    ...actions,
    canDock: hosts > 0,
    active: open && hosts > 0,
    open,
    sessionKey: dockStore.key,
    state,
    activeTab: state === null ? null : activeTabOf(state),
    allTabs,
    pinnedIds,
    split,
    setSplit,
    registerHost,
  }), [actions, hosts, open, dockStore.key, state, allTabs, pinnedIds, split, setSplit, registerHost]);
}

export function DockProvider({ children }: { children: ReactNode }): JSX.Element {
  const [dockStore, setStore] = useState<DockStore>(EMPTY_DOCK_STORE);
  const actions = useDockActions(setStore);
  const value = useDockValue(dockStore, actions);
  const intake = useIntake(value);
  return (
    <DockContext.Provider value={value}>
      <DockIntakeProvider value={intake}>{children}</DockIntakeProvider>
    </DockContext.Provider>
  );
}

export function useDock(): DockContextValue {
  return useContext(DockContext);
}
