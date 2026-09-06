// input:  dock state, file bodies, browser bodies and divider drags
// output: the workbench's fourth pane — one tab strip over live tab bodies
// pos:    Dock host; the only place a tab's kind chooses a body
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useCallback, useEffect, useRef, type CSSProperties } from 'react';
import { WebBody } from '@/features/browser/WebBody';
import { useDownloadFile } from '@/features/media/useDownloadFile';
import { splitFromDrag } from './dock-split';
import { DockCentered, DockFileBody, dockFileBodyStyle } from './DockFileBody';
import { DockTabStrip } from './DockTabStrip';
import { useDock } from './DockProvider';
import {
  dockDownloadPath,
  isFileTab,
  syncBodyOrder,
  type DockState,
  type DockTab,
  type WebDockTab,
} from './dock-tabs';

// THE DOCK PANE — mounted by the workbench frame as a flex sibling between CenterChat and
// RightPanel, so opening it splits the center region into chat (left) | dock (right) instead of
// covering the chat with a scrim. Its left edge is a drag divider (split ratio persisted).
//
// EVERY tab body stays mounted; only the active one is displayed. That is what makes a switch
// non-destructive — a web tab keeps its live document, scroll position and HMR connection, and a
// file tab keeps its PDF page and image zoom. Bodies are rendered in their own insertion order
// (`syncBodyOrder`), never the strip's display order, so dragging a tab moves only its chrome:
// re-parenting an iframe would tear its document down.

const EMPTY_HINT = 'Click a file to preview it here, or open a web page with ＋.';

export function DockPane(): JSX.Element | null {
  const { open, state, split, closeDock, select, close, reorder, openWeb, updateWeb, setSplit, registerHost } = useDock();
  const paneRef = useRef<HTMLDivElement | null>(null);
  const bodyOrder = useRef<string[]>([]);
  const dl = useDownloadFile();

  useEffect(() => registerHost(), [registerHost]);

  bodyOrder.current = syncBodyOrder(bodyOrder.current, state?.tabs ?? []);

  // Divider drag: the resizable region is the chat pane + this pane (the two rails are fixed-width),
  // measured from this pane and its preceding sibling at drag start.
  const onResizeStart = (e: React.MouseEvent): void => {
    e.preventDefault();
    const pane = paneRef.current;
    const chat = pane?.previousElementSibling as HTMLElement | null;
    if (!pane || !chat) return;
    const paneRect = pane.getBoundingClientRect();
    const chatRect = chat.getBoundingClientRect();
    const regionLeft = chatRect.left;
    const regionWidth = chatRect.width + paneRect.width;
    let last = split;
    const onMove = (ev: MouseEvent): void => {
      last = splitFromDrag(regionLeft, regionWidth, ev.clientX);
      setSplit(last);
    };
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      setSplit(last, true);
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Closing the dock hides it but keeps its tabs alive, so reopening resumes where it left off.
  // The pane therefore stays mounted while it holds tabs, and only disappears once it holds none.
  if (!open && state === null) return null;

  const activeTab = state === null ? null : state.tabs.find((tab) => tab.id === state.activeId) ?? null;
  const downloadPath = activeTab ? dockDownloadPath(activeTab) : null;

  return (
    <div ref={paneRef} data-pane="dock" style={{ ...PANE_STYLE, flexGrow: split, display: open ? 'flex' : 'none' }}>
      {/* Divider — drag to re-balance chat vs dock. */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onMouseDown={onResizeStart}
        style={{ position: 'absolute', left: -3, top: 0, bottom: 0, width: 6, cursor: 'col-resize', zIndex: 3 }}
      />

      <DockTabStrip
        state={state}
        onAdd={openWeb}
        onSelect={select}
        onClose={close}
        onReorder={reorder}
        actions={
          <>
            {downloadPath && activeTab && isFileTab(activeTab) && (
              <span role="button" title="Download" onClick={() => dl(downloadPath, activeTab.item.name)} style={ACTION_STYLE}>↓</span>
            )}
            <span role="button" data-close-dock="" title="Close the dock" onClick={closeDock} style={{ ...ACTION_STYLE, fontSize: 16 }}>×</span>
          </>
        }
      />

      <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden', background: 'var(--proto-card)' }}>
        {state === null
          ? <DockCentered>{EMPTY_HINT}</DockCentered>
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
    ...(isFileTab(tab) ? dockFileBodyStyle(tab.item) : {}),
    display: active ? 'flex' : 'none',
  };
  return (
    <div data-dock-tab-body={tab.id} style={style}>
      {isFileTab(tab) ? <DockFileBody item={tab.item} /> : <WebBody tab={tab} active={active} onUpdate={update} />}
    </div>
  );
}

const PANE_STYLE: CSSProperties = {
  flexShrink: 1,
  flexBasis: 0,
  minWidth: 0,
  flexDirection: 'column',
  minHeight: 0,
  background: 'var(--proto-card)',
  borderLeft: '1px solid var(--proto-line)',
  position: 'relative',
};

const ACTION_STYLE: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: '1px solid var(--proto-line)',
  background: 'var(--proto-card)',
  color: 'var(--proto-muted)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontSize: 13,
  cursor: 'pointer',
  flex: 'none',
  userSelect: 'none',
};
