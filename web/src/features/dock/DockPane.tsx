import { useCallback, useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { WebBody } from '@/features/browser/WebBody';
import { BoardDockBody } from '@/features/board/BoardDockBody';
import { AgentBrowserView } from '@/features/agent-browser/AgentBrowserView';
import { DockDivider } from './DockDivider';
import { DockCentered, DockFileBody, dockFileBackground } from './DockFileBody';
import { CloseGlyph, DockTabStrip } from './DockTabStrip';
import { useDock } from './DockProvider';
import { useVocabOptional } from '@/i18n';
import {
  isAgentBrowserTab,
  isBoardTab,
  isFileTab,
  syncBodyOrder,
  type DockTab,
  type WebDockTab,
} from './dock-tabs';

// THE DOCK PANE — mounted by the workbench frame as a flex sibling after CenterChat, so opening it
// splits the center region into chat (left) | dock (right) instead of covering the chat with a scrim. Its left edge is a drag divider (split ratio persisted).
//
// EVERY tab body stays mounted — every session's, not just the selected one's — and only the
// selected strip's active one is displayed. That is what makes a switch (of tab or of session)
// non-destructive — a web tab keeps its live document, scroll position and HMR connection, and a
// file tab keeps its PDF page and image zoom. Bodies are rendered in their own insertion order
// (`syncBodyOrder`), never the strip's display order, so dragging a tab moves only its chrome:
// re-parenting an iframe would tear its document down.
//
// The strip carries NO per-tab actions: with one strip over two kinds of body, a download or a
// source toggle up there would belong to whatever happened to be active. Each body owns its own
// row instead (`FileBar`, or a PDF's page pager); the strip keeps only the dock-wide close.

type Dock = ReturnType<typeof useDock>;

export function DockPane(): JSX.Element | null {
  const dock = useDock();
  const { open, allTabs, split, setSplit, registerHost } = dock;
  const paneRef = useRef<HTMLDivElement | null>(null);
  const L = useVocabOptional();

  useEffect(() => registerHost(), [registerHost]);

  // Closing the dock hides it but keeps its tabs alive, so reopening resumes where it left off.
  // The pane therefore stays mounted while any session holds tabs, and only disappears once none do.
  if (!open && allTabs.length === 0) return null;

  return (
    <div ref={paneRef} data-pane="dock" style={{ ...PANE_STYLE, flexGrow: split, display: open ? 'flex' : 'none' }}>
      <DockDivider split={split} label={L.dockResize} paneRef={paneRef} onCommit={(value) => setSplit(value, true)} />
      {/* Keyed by session: a switch swaps the whole strip at once instead of animating every tab
          out and in, and drops a menu left open on the other session's tab. */}
      <PaneStrip key={dock.sessionKey} dock={dock} />
      {/* Chrome lets the workspace sheet show through; documents own their opaque fill. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        <PaneBodies dock={dock} />
      </div>
    </div>
  );
}

function PaneStrip({ dock }: { dock: Dock }): JSX.Element {
  const L = useVocabOptional();
  return (
    <DockTabStrip
      state={dock.state}
      pinnedIds={dock.pinnedIds}
      onAdd={dock.openWeb}
      onSelect={dock.select}
      onClose={dock.close}
      onReorder={dock.reorder}
      onPin={dock.pin}
      onUnpin={dock.unpin}
      actions={
        <button type="button" className="dock-control" data-close-dock="" title={L.dockCloseDock} aria-label={L.dockCloseDock} onClick={dock.closeDock}>
          <CloseGlyph size={13} />
        </button>
      }
    />
  );
}

function PaneBodies({ dock }: { dock: Dock }): JSX.Element {
  const { state, allTabs, open, updateWeb } = dock;
  const bodyOrder = useRef<string[]>([]);
  const tabsById = useMemo(() => new Map(allTabs.map((tab) => [tab.id, tab])), [allTabs]);
  const L = useVocabOptional();
  bodyOrder.current = syncBodyOrder(bodyOrder.current, allTabs);
  return (
    <>
      {state === null && <DockCentered>{L.dockEmptyHint}</DockCentered>}
      {bodyOrder.current.map((id) => {
        const tab = tabsById.get(id);
        return tab ? <DockTabBody key={id} tab={tab} active={id === state?.activeId} paneOpen={open} onUpdateWeb={updateWeb} /> : null;
      })}
    </>
  );
}

function DockTabBody({ tab, active, paneOpen, onUpdateWeb }: {
  tab: DockTab;
  active: boolean;
  paneOpen: boolean;
  onUpdateWeb: (id: string, update: (tab: WebDockTab) => WebDockTab) => void;
}): JSX.Element {
  const update = useCallback((next: (entry: WebDockTab) => WebDockTab) => onUpdateWeb(tab.id, next), [tab.id, onUpdateWeb]);
  // `display` is applied LAST: a file body's own style carries one (media centers itself with
  // flex), and letting that win would leave every hidden media tab painted over the active one.
  const style: CSSProperties = {
    position: 'absolute',
    inset: 0,
    flexDirection: 'column',
    minHeight: 0,
    overflow: 'hidden',
    background: isFileTab(tab) ? dockFileBackground(tab.item) : 'transparent',
    display: active ? 'flex' : 'none',
  };
  return (
    <div data-dock-tab-body={tab.id} style={style}>
      {isFileTab(tab) ? <DockFileBody item={tab.item} />
        : isBoardTab(tab) ? <BoardDockBody boardId={tab.boardId} />
          : isAgentBrowserTab(tab) ? <AgentBrowserView sessionId={tab.sessionId} visible={active && paneOpen} />
            : <WebBody tab={tab} active={active} onUpdate={update} />}
    </div>
  );
}

const PANE_STYLE: CSSProperties = {
  flexShrink: 1,
  flexBasis: 0,
  minWidth: 0,
  flexDirection: 'column',
  minHeight: 0,
  background: 'transparent',
  borderLeft: '1px solid var(--proto-line)',
  position: 'relative',
};
