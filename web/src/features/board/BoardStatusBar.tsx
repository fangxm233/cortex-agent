import type { CSSProperties, KeyboardEvent } from 'react';
import { useDockIntake } from '@/design/dock-intake';
import { MENU_FOCUS, MONO } from '@/design/MenuChrome';
import { fmt, useVocab } from '@/i18n';
import { BoardIcon } from './BoardIcon';
import { BoardPeers, BoardPendingChip } from './BoardPeers';
import { BOARD_FLAG_COLOR, boardFlagTone, boardSummary } from './board-summary';
import { useBoardLive } from './useBoard';
import './board-bar.css';

// A bound session's board, as one line under the chat header (desktop) or the phone's header: the
// flag, the board, who is doing what, and what waits on the user. The whole line opens it.

const BAR: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, padding: '6px 11px', boxSizing: 'border-box',
  borderRadius: 'var(--r-control)', border: '1px solid var(--border-card)', background: 'var(--material-card-bg)',
  boxShadow: 'var(--material-card-shadow)', fontSize: 12, lineHeight: '18px', color: 'var(--proto-ink)',
  whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'pointer',
};
const ELLIPSIS: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' };
const META: CSSProperties = { flex: 'none', font: `400 11px ${MONO}`, color: 'var(--proto-muted)' };

function Sep({ className }: { className?: string }): JSX.Element {
  return <span aria-hidden="true" className={className} style={{ flex: 'none', width: 1, height: 12, background: 'var(--proto-line-3)' }} />;
}

export function BoardStatusBar({ boardId, onOpen, column }: {
  boardId: string;
  onOpen: () => void;
  /** Desktop: inset and capped like the chat column and composer. */
  column?: boolean;
}): JSX.Element | null {
  const L = useVocab();
  const { board, sessions, decisions } = useBoardLive(boardId);
  if (!board) return null;
  const { shown, pending } = boardSummary(sessions);
  const tone = boardFlagTone(pending.length);
  const name = `${L.boardTitle} · ${board.title}`;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(); }
  };

  const bar = (
    <div className="board-bar-frame" style={column ? { maxWidth: 760, margin: '0 auto' } : undefined}>
      <div role="button" tabIndex={0} className={`board-bar ${MENU_FOCUS}`} data-board-bar={boardId} data-board-flag={tone}
        aria-label={`${L.boardOpen} · ${board.title}`} title={name} onClick={onOpen} onKeyDown={onKeyDown} style={BAR}>
        <BoardIcon size={12} stroke={BOARD_FLAG_COLOR[tone]} />
        <span style={{ ...ELLIPSIS, flexShrink: 1, fontWeight: 600 }}>{name}</span>
        {shown.length > 0 && (
          <span className="board-bar-sessions" style={{ alignItems: 'center', gap: 10, minWidth: 0, flexShrink: 1 }}>
            <Sep />
            <BoardPeers sessions={shown} />
          </span>
        )}
        <Sep className={pending.length > 0 ? undefined : 'board-bar-decisions'} />
        <BoardPendingChip count={pending.length} />
        <span className="board-bar-decisions" style={META}>{fmt(L.boardDecisions, { n: decisions.length })}</span>
        <span style={{ ...META, marginLeft: 'auto' }}>{L.boardBarOpen} →</span>
      </div>
    </div>
  );
  return column ? <div data-board-bar-slot="" style={{ flex: 'none', padding: '8px 32px 0' }}>{bar}</div> : bar;
}

/** The desktop chat's bar: opens the board in the dock, and steps aside while the dock already shows it. */
export function DockedBoardBar({ boardId }: { boardId: string }): JSX.Element | null {
  const { canDock, active, activeBoardId, openBoard } = useDockIntake();
  if (!canDock || (active && activeBoardId === boardId)) return null;
  return <BoardStatusBar boardId={boardId} column onOpen={() => openBoard(boardId)} />;
}
