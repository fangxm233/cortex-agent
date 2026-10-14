import { IconButton } from '@/design/IconButton';
import { useDockIntake } from '@/design/dock-intake';
import { useVocab } from '@/i18n';
import { BoardIcon } from './BoardIcon';
import { useBoardTitle } from './useBoard';

/** The chat header's entry to a bound session's board: an icon beside Browser and Notes that opens it in the dock. */
export function BoardHeaderButton({ boardId }: { boardId: string }): JSX.Element | null {
  const L = useVocab();
  const { canDock, active, activeBoardId, openBoard } = useDockIntake();
  const title = useBoardTitle(boardId);
  if (!canDock) return null;
  const open = active && activeBoardId === boardId;
  return (
    <IconButton
      data-board-button={boardId}
      size={28}
      tone="accent"
      active={open}
      aria-pressed={open}
      label={title ? `${L.boardTitle} · ${title}` : L.boardTitle}
      onClick={() => openBoard(boardId)}
    >
      <BoardIcon size={15} strokeWidth={1.25} />
    </IconButton>
  );
}
