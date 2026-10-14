import { useState } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';
import { useDockIntake } from '@/design/dock-intake';
import { useVocab } from '@/i18n';
import { BoardIcon } from './BoardIcon';
import { useBoardTitle } from './useBoard';

/** The chat header's entry to a bound session's board: opens it as a dock tab. */
export function BoardHeaderButton({ boardId }: { boardId: string }): JSX.Element | null {
  const L = useVocab();
  const { canDock, active, activeBoardId, openBoard } = useDockIntake();
  const title = useBoardTitle(boardId);
  const [hover, setHover] = useState(false);
  if (!canDock) return null;
  const pressed = active && activeBoardId === boardId;
  return (
    <button
      type="button"
      data-board-button={boardId}
      className={MENU_FOCUS}
      aria-pressed={pressed}
      title={title ? `${L.boardOpen} · ${title}` : L.boardOpen}
      onClick={() => openBoard(boardId)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, height: 28, padding: '0 9px', marginRight: 4,
        whiteSpace: 'nowrap', flexShrink: 0,
        border: 0, borderRadius: 'var(--r-chip)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
        color: pressed ? 'var(--proto-accent)' : 'var(--proto-ink-2)',
        background: pressed ? 'var(--proto-accent-bg)' : hover ? 'var(--proto-card)' : 'color-mix(in srgb, var(--proto-card) 60%, transparent)',
        boxShadow: `0 0 0 1px ${pressed ? 'var(--proto-accent-border)' : 'var(--proto-line)'}`,
      }}
    >
      <BoardIcon size={12} stroke={pressed ? 'var(--proto-accent)' : 'var(--proto-muted)'} />
      {L.boardTitle}
    </button>
  );
}
