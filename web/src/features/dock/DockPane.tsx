import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { WebBody } from '@/features/browser/WebBody';
import { BoardDockBody } from '@/features/board/BoardDockBody';
import { DockDivider } from './DockDivider';
import { DockCentered, DockFileBody, dockFileBackground } from './DockFileBody';
import { DockTabStrip } from './DockTabStrip';
import { useDock } from './DockProvider';
import { useVocabOptional } from '@/i18n';
import {
  isBoardTab,
  isFileTab,
  syncBodyOrder,
  type DockState,
  type DockTab,
  type WebDockTab,
} from './dock-tabs';

// THE DOCK PANE — mounted by the workbench frame as a flex sibling after CenterChat, so opening it
// splits the center region into chat (left) | dock (right) instead of covering the chat with a scrim. Its left edge is a drag divider (split ratio persisted).
//
// EVERY tab body stays mounted; only the active one is displayed. That is what makes a switch
// non-destructive — a web tab keeps its live document, scroll position and HMR connection, and a
// file tab keeps its PDF page and image zoom. Bodies are rendered in their own insertion order
// (`syncBodyOrder`), never the strip's display order, so dragging a tab moves only its chrome:
// re-parenting an iframe would tear its document down.
//
// The strip carries NO per-tab actions: with one strip over two kinds of body, a download or a
// source toggle up there would belong to whatever happened to be active. Each body owns its own
// row instead (`FileBar`, or a PDF's page pager); the strip keeps only the dock-wide close.

export function DockPane(): JSX.Element | null {
  const { open, state, split, closeDock, select, close, reorder, openWeb, updateWeb, setSplit, registerHost } = useDock();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const bodyOrder = useRef<string[]>([]);
  const L = useVocabOptional();

  useEffect(() => registerHost(), [registerHost]);

  bodyOrder.current = syncBodyOrder(bodyOrder.current, state?.tabs ?? []);

  // Closing the dock hides it but keeps its tabs alive, so reopening resumes where it left off.
  // The pane therefore stays mounted while it holds tabs, and only disappears once it holds none.
  if (!open && state === null) return null;

  return (
    <div ref={paneRef} data-pane="dock" style={{ ...PANE_STYLE, flexGrow: split, display: open ? 'flex' : 'none' }}>
      <DockDivider split={split} label={L.dockResize} paneRef={paneRef} onCommit={(value) => setSplit(value, true)} />

      <DockTabStrip
        state={state}
        onAdd={openWeb}
        onSelect={select}
        onClose={close}
        onReorder={reorder}
        actions={
          <button type="button" className="dock-control" data-close-dock="" title={L.dockCloseDock} aria-label={L.dockCloseDock} onClick={closeDock}>×</button>
        }
      />

      {/* Chrome lets the workspace sheet show through; documents own their opaque fill. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
        {state === null
          ? <DockCentered>{L.dockEmptyHint}</DockCentered>
          : bodyOrder.current.map((id) => (
            <DockTabBody key={id} state={state} id={id} onUpdateWeb={updateWeb} />
          ))}
      </div>
    </div>
  );
}

function DockTabBody({ state, id, onUpdateWeb }: {
  state: DockState;
  id: string;
  onUpdateWeb: (id: string, update: (tab: WebDockTab) => WebDockTab) => void;
}): JSX.Element | null {
  const tab: DockTab | undefined = state.tabs.find((candidate) => candidate.id === id);
  const update = useCallback((next: (entry: WebDockTab) => WebDockTab) => onUpdateWeb(id, next), [id, onUpdateWeb]);
  if (!tab) return null;
  const active = tab.id === state.activeId;
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
