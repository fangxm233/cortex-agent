import { type CSSProperties } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { MobileOverlayPortal } from '@/design/mobile-overlay-host';
import { useBackDismiss } from '@/design/use-back-dismiss';
import { useVocabOptional } from '@/i18n';
import { BoardView } from '@/features/board/BoardView';
import { useBoardTitle } from '@/features/board/useBoard';
import { MBackChevron, MC } from '@/mobile/ui/kit';

// A bound session's board on the phone: its capsule above the composer opens it as a full-screen
// sheet over the chat — the same view the desktop docks.

// The sheet stands on the app's own opaque ground, not glass. A translucent fill relied on the
// backdrop blur to hide the chat beneath, and Chromium (the Android WebView) leaves the chat's
// separately composited header and masked transcript unblurred behind it, so they read through.
const SHEET: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 12, display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
  background: MC.backdrop,
  paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', boxSizing: 'border-box',
};

const TITLE: CSSProperties = {
  minWidth: 0, fontSize: 15.5, fontWeight: 620, color: MC.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

export function MBoardSheet({ boardId, onClose, onOpenSession }: {
  boardId: string;
  onClose: () => void;
  onOpenSession: (session: SessionInfo) => void;
}): JSX.Element {
  const L = useVocabOptional();
  // The header names the board, so the strip below leaves its own title out; until the board loads
  // the header says what kind of page this is.
  const title = useBoardTitle(boardId) ?? L.boardTitle;
  useBackDismiss(onClose);
  return (
    <MobileOverlayPortal>
      <div data-board-sheet={boardId} style={SHEET}>
        <div style={{ flex: 'none', height: 48, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 0 4px', minWidth: 0 }}>
          <button type="button" aria-label={L.back} onClick={onClose}
            style={{ width: 44, height: 44, border: 0, padding: 0, background: 'transparent', cursor: 'pointer',
              display: 'grid', placeItems: 'center', color: MC.ink }}>
            <MBackChevron />
          </button>
          <span data-board-sheet-title="" style={TITLE}>{title}</span>
        </div>
        <BoardView boardId={boardId} touch showTitle={false} onOpenSession={(s) => { onClose(); onOpenSession(s); }} />
      </div>
    </MobileOverlayPortal>
  );
}
