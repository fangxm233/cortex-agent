import { useState, type CSSProperties } from 'react';
import { useDockIntake } from '@/design/dock-intake';
import { MENU_FOCUS, MONO } from '@/design/MenuChrome';
import { fmt, useVocab } from '@/i18n';
import { ActivityChip, CHIP_COUNT } from '@/features/session/rail/ActivityChip';
import { BoardIcon } from './BoardIcon';
import { BOARD_FLAG_COLOR, boardFlagTone, boardSummary } from './board-summary';
import { useBoardLive } from './useBoard';

// A bound session's board: a capsule among the desktop chat header's actions, a capsule in the
// phone's activity strip. Both name what waits on the user and open the board; who is doing what
// lives on the board itself.

const PENDING: CSSProperties = { flex: 'none', font: `500 11px ${MONO}`, color: 'var(--proto-amber-fg)' };

/** Desktop: the board's flag and title, plus how many wait on the user. */
export function BoardCapsule({ boardId, onOpen }: { boardId: string; onOpen: () => void }): JSX.Element | null {
  const L = useVocab();
  const { board, sessions } = useBoardLive(boardId);
  const [hover, setHover] = useState(false);
  if (!board) return null;
  const { pending } = boardSummary(sessions);
  const tone = boardFlagTone(pending.length);
  const ask = tone === 'ask';
  return (
    <button type="button" data-board-capsule={boardId} data-board-flag={tone} className={MENU_FOCUS}
      aria-label={`${L.boardOpen} · ${board.title}`} title={`${L.boardTitle} · ${board.title}`} onClick={onOpen}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 28, maxWidth: 260, padding: '0 9px',
        marginRight: 4, border: 0, borderRadius: 'var(--r-chip)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
        color: 'var(--proto-ink-2)', whiteSpace: 'nowrap',
        background: ask ? 'var(--proto-amber-bg)' : hover ? 'var(--proto-card)' : 'color-mix(in srgb, var(--proto-card) 60%, transparent)',
        boxShadow: `0 0 0 1px ${ask ? 'var(--proto-amber-border)' : 'var(--proto-line)'}`,
      }}>
      <BoardIcon size={12} stroke={BOARD_FLAG_COLOR[tone]} />
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{board.title}</span>
      {ask && <span data-board-pending-count={pending.length} style={PENDING}>{fmt(L.boardNeedsYou, { n: pending.length })}</span>}
    </button>
  );
}

/** The desktop header's capsule: opens the board in the dock, and steps aside while the dock already
 *  shows it. */
export function DockedBoardCapsule({ boardId }: { boardId: string }): JSX.Element | null {
  const { canDock, active, activeBoardId, openBoard } = useDockIntake();
  if (!canDock || (active && activeBoardId === boardId)) return null;
  return <BoardCapsule boardId={boardId} onOpen={() => openBoard(boardId)} />;
}

/** Phone: the flag alone, with the count of what waits on the user once there is any. */
export function BoardChip({ boardId, onOpen }: { boardId: string; onOpen: () => void }): JSX.Element | null {
  const L = useVocab();
  const { board, sessions } = useBoardLive(boardId);
  if (!board) return null;
  const { pending } = boardSummary(sessions);
  const tone = boardFlagTone(pending.length);
  const label = [`${L.boardOpen} · ${board.title}`, pending.length > 0 ? fmt(L.boardNeedsYou, { n: pending.length }) : null]
    .filter(Boolean).join(' · ');
  return (
    <ActivityChip data="board" label={label} tone={tone === 'ask' ? 'ask' : 'plain'} floating onClick={onOpen}>
      <BoardIcon size={13} stroke={BOARD_FLAG_COLOR[tone]} />
      {pending.length > 0 && <span data-board-pending-count={pending.length} style={CHIP_COUNT}>{pending.length}</span>}
    </ActivityChip>
  );
}
