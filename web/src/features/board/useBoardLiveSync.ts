import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { BOARD_LIVE_EVENTS, type LiveEvent } from '@/features/live/live-events';

function payloadOf(ev: LiveEvent): Record<string, unknown> {
  return ev.payload && typeof ev.payload === 'object' ? (ev.payload as Record<string, unknown>) : {};
}

/**
 * Keep board surfaces current. `board.updated` covers the record, the directory (body, assets,
 * decisions) and the bound sessions, so it refetches the board queries and the body files;
 * `session.board` moves a binding; `board.style-updated` swaps the user stylesheet.
 * `onBoardUpdated` lets an open body re-inline its assets even when its text did not change.
 */
export function useBoardLiveSync(onBoardUpdated?: (boardId: string) => void): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(BOARD_LIVE_EVENTS, (ev) => {
    if (ev.type === 'board.style-updated') {
      void queryClient.invalidateQueries(trpc.boards.style.queryFilter());
      return;
    }
    if (ev.type === 'session.board') {
      void queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
      return;
    }
    void queryClient.invalidateQueries(trpc.boards.list.queryFilter());
    void queryClient.invalidateQueries(trpc.boards.get.queryFilter());
    void queryClient.invalidateQueries(trpc.boards.decisions.queryFilter());
    void queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
    void queryClient.invalidateQueries({
      ...trpc.memory.file.queryFilter(),
      predicate: (query) => {
        const input = (query.queryKey[1] as { input?: { path?: unknown } } | undefined)?.input;
        return typeof input?.path === 'string' && input.path.startsWith('boards/');
      },
    });
    const boardId = payloadOf(ev).boardId;
    if (typeof boardId === 'string') onBoardUpdated?.(boardId);
  });
}
