import { useDockIntake } from '@/design/dock-intake';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';

// Desktop: when the agent in the chat on screen creates a board, the board opens in the dock. Only
// the live event does this — rows read back from the transcript (scrolling up, a reload, switching
// sessions) never do — and each board opens on its own at most once per page load, so closing its
// tab sticks.

const SESSION_MESSAGE = ['session.message'] as const;

/** The board a live `session.message` payload asks to open for `sessionId`, or null. Records the
 *  board in `opened`, so a second event for it returns null. */
export function boardToAutoOpen(payload: unknown, sessionId: string | null, opened: Set<string>): string | null {
  if (!sessionId || !payload || typeof payload !== 'object') return null;
  const p = payload as { sessionId?: unknown; boardAction?: { boardId?: unknown; created?: unknown } };
  if (p.sessionId !== sessionId) return null;
  const action = p.boardAction;
  if (!action || action.created !== true || typeof action.boardId !== 'string') return null;
  if (opened.has(action.boardId)) return null;
  opened.add(action.boardId);
  return action.boardId;
}

/** Boards opened this way in this page load. */
const autoOpened = new Set<string>();

export function useAutoOpenNewBoard(sessionId: string | null): void {
  const { canDock, openBoard } = useDockIntake();
  useLiveEvents(SESSION_MESSAGE, (ev) => {
    if (!canDock) return;
    const boardId = boardToAutoOpen(ev.payload, sessionId, autoOpened);
    if (boardId) openBoard(boardId);
  });
}
