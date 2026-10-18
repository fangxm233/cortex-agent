import { useState, type CSSProperties } from 'react';
import { useDockIntake } from '@/design/dock-intake';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { fmt, useVocab } from '@/i18n';
import { ActivityChip, CHIP_COUNT, capsuleStyle, useHeaderCapsuleFit } from '@/features/session/rail/ActivityChip';
import { BoardIcon } from './BoardIcon';
import { BOARD_FLAG_COLOR, boardFlagTone, boardSummary } from './board-summary';
import { useBoardLive } from './useBoard';

// A bound session's board: a capsule among the desktop chat header's actions, a capsule in the
// phone's activity strip. Both name what waits on the user and open the board; who is doing what
// lives on the board itself.

const PENDING: CSSProperties = { flex: 'none', fontWeight: 550, color: 'var(--proto-amber-fg)' };

/** Desktop: the board's flag and title, plus how many wait on the user. The header's shared capsule:
 *  a quiet flag at rest; once something waits on the user the flag and the count turn amber, while
 *  the capsule itself keeps its hairline and fill. When the header runs short it folds to the flag
 *  and the bare amber count; the title and the full count stay in its tooltip and label. */
export function BoardCapsule({ boardId, onOpen }: { boardId: string; onOpen: () => void }): JSX.Element | null {
  const L = useVocab();
  const compact = useHeaderCapsuleFit().board === 'compact';
  const { board, sessions } = useBoardLive(boardId);
  const [hover, setHover] = useState(false);
  if (!board) return null;
  const { pending } = boardSummary(sessions);
  const tone = boardFlagTone(pending.length);
  const ask = tone === 'ask';
  const waiting = ask ? fmt(L.boardNeedsYou, { n: pending.length }) : null;
  return (
    <button type="button" data-board-capsule={boardId} data-board-flag={tone} data-compact={compact ? 'true' : undefined}
      className={MENU_FOCUS} onClick={onOpen}
      aria-label={[`${L.boardOpen} · ${board.title}`, waiting].filter(Boolean).join(' · ')}
      title={[`${L.boardTitle} · ${board.title}`, waiting].filter(Boolean).join(' · ')}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ ...capsuleStyle({ lit: hover }), maxWidth: 260, minWidth: 0, ...(compact ? { padding: '0 10px' } : null) }}>
      <BoardIcon size={13} stroke={ask ? BOARD_FLAG_COLOR.ask : 'var(--proto-muted)'} />
      {!compact && <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{board.title}</span>}
      {ask && (
        <span data-board-pending-count={pending.length} style={PENDING}>
          {compact ? pending.length : waiting}
        </span>
      )}
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
