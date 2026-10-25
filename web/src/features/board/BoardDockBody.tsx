import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDockIntake } from '@/design/dock-intake';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { useSelectedSession } from '@/features/session/state/SelectedSessionProvider';
import { BoardView } from './BoardView';
import { useBoardTitle } from './useBoard';

/** The dock's board tab body: opening a bound session selects it in the workbench beside the dock,
 *  and the board opens in that session's strip so it stays beside the chat. The tab names the
 *  board, so the strip below it carries no title of its own. */
export function BoardDockBody({ boardId }: { boardId: string }): JSX.Element {
  const navigate = useNavigate();
  const { setCurrentProject } = useCurrentProject();
  const { setSelectedSession } = useSelectedSession();
  const { openBoard } = useDockIntake();
  const openSession = useCallback((session: SessionInfo) => {
    setCurrentProject(session.projectId);
    setSelectedSession(session.sessionId);
    openBoard(boardId, session.sessionId);
    navigate('/workbench');
  }, [boardId, navigate, openBoard, setCurrentProject, setSelectedSession]);
  return <BoardView boardId={boardId} onOpenSession={openSession} showTitle={false} />;
}

/** A board tab's label: the board's live title. */
export function BoardTabTitle({ boardId }: { boardId: string }): JSX.Element {
  const L = useVocab();
  return <>{useBoardTitle(boardId) ?? L.boardTitle}</>;
}
