import { type CSSProperties } from 'react';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { MobileOverlayPortal } from '@/design/mobile-overlay-host';
import { useBackDismiss } from '@/design/use-back-dismiss';
import { useVocabOptional } from '@/i18n';
import { BoardIcon } from '@/features/board/BoardIcon';
import { BoardView } from '@/features/board/BoardView';
import { MC } from '@/mobile/ui/kit';

// A bound session's board on the phone: the chat header carries a board key, and the board opens as
// a full-screen sheet over the chat — the same view the desktop docks.

const SHEET: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 12, display: 'flex', flexDirection: 'column', pointerEvents: 'auto',
  background: 'var(--material-overlay-bg)', backdropFilter: 'var(--glass-filter)', WebkitBackdropFilter: 'var(--glass-filter)',
  paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)', boxSizing: 'border-box',
};

export function MBoardKey({ onOpen }: { onOpen: () => void }): JSX.Element {
  const L = useVocabOptional();
  return (
    <button type="button" data-board-key="" aria-label={L.boardOpen} onClick={onOpen}
      style={{ flex: 'none', width: 40, height: 44, border: 0, padding: 0, background: 'transparent', cursor: 'pointer',
        display: 'grid', placeItems: 'center', color: 'var(--proto-accent)' }}>
      <BoardIcon size={17} />
    </button>
  );
}

export function MBoardSheet({ boardId, onClose, onOpenSession }: {
  boardId: string;
  onClose: () => void;
  onOpenSession: (session: SessionInfo) => void;
}): JSX.Element {
  const L = useVocabOptional();
  useBackDismiss(onClose);
  return (
    <MobileOverlayPortal>
      <div data-board-sheet={boardId} style={SHEET}>
        <div style={{ flex: 'none', height: 48, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 4px' }}>
          <button type="button" aria-label={L.back} onClick={onClose}
            style={{ width: 44, height: 44, border: 0, padding: 0, background: 'transparent', cursor: 'pointer',
              display: 'grid', placeItems: 'center', color: 'var(--proto-accent)' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 6-6 6 6 6" />
            </svg>
          </button>
          <span style={{ fontSize: 15, fontWeight: 600, color: MC.ink }}>{L.boardTitle}</span>
        </div>
        <BoardView boardId={boardId} touch onOpenSession={(s) => { onClose(); onOpenSession(s); }} />
      </div>
    </MobileOverlayPortal>
  );
}
