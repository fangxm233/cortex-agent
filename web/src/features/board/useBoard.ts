import { useMemo } from 'react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { boardBodyPath, boardDir, LEGACY_BOARD_FILES } from './board-paths';

export type BoardBodyState =
  | { kind: 'loading' }
  | { kind: 'body'; html: string }
  /** No board.html: the board predates bodies. `files` are the legacy files that exist. */
  | { kind: 'empty'; files: string[] };

export interface BoardData {
  board: BoardInfo | null;
  /** The board query failed or the board is gone. */
  missing: boolean;
  body: BoardBodyState;
  style: { defaultCss: string; userCss: string | null } | null;
  decisions: ReturnType<typeof useBoardDecisions>;
  /** Sessions bound to this board, from the shared session list. */
  sessions: SessionInfo[];
}

function useBoardDecisions(boardId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.boards.decisions.queryOptions({ boardId })).data ?? [];
}

export function useBoard(boardId: string): BoardData {
  const trpc = useTRPC();
  const boardQuery = useQuery({ ...trpc.boards.get.queryOptions({ boardId }), retry: false });
  const board = boardQuery.data ?? null;
  const styleQuery = useQuery({ ...trpc.boards.style.queryOptions({}), staleTime: Infinity });
  const sessionsQuery = useQuery({ ...trpc.sessions.list.queryOptions({}), refetchOnMount: false });
  const decisions = useBoardDecisions(boardId);

  const projectId = board?.projectId ?? '';
  const slug = board?.slug ?? '';
  const bodyQuery = useQuery({
    ...trpc.memory.file.queryOptions({ projectId, path: boardBodyPath(slug) }),
    enabled: !!board,
    retry: false,
  });
  const bodyMissing = !!board && bodyQuery.isError;
  // Only a board without a body probes for the files a migrated board carries instead.
  const legacy = useQueries({
    queries: LEGACY_BOARD_FILES.map((name) => ({
      ...trpc.memory.file.queryOptions({ projectId, path: boardDir(slug) + name }),
      enabled: bodyMissing,
      retry: false,
    })),
  });

  const sessions = useMemo(
    () => (sessionsQuery.data ?? []).filter((s) => s.boardId === boardId),
    [sessionsQuery.data, boardId],
  );

  let body: BoardBodyState = { kind: 'loading' };
  if (bodyQuery.data) body = { kind: 'body', html: bodyQuery.data.content };
  else if (bodyMissing && legacy.every((q) => !q.isLoading)) {
    body = { kind: 'empty', files: LEGACY_BOARD_FILES.filter((_, i) => !!legacy[i]?.data) };
  }

  return {
    board,
    missing: boardQuery.isError && !board,
    body,
    style: styleQuery.data ?? null,
    decisions,
    sessions,
  };
}

export function useCloseBoard(boardId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation(trpc.boards.close.mutationOptions({
    onSettled: () => {
      void queryClient.invalidateQueries(trpc.boards.list.queryFilter());
      void queryClient.invalidateQueries(trpc.boards.get.queryFilter({ boardId }));
    },
  }));
}

/** Every board, open ones first, each group newest first. */
export function useBoardList() {
  const trpc = useTRPC();
  const query = useQuery(trpc.boards.list.queryOptions({}));
  return useMemo(() => sortBoards(query.data ?? []), [query.data]);
}

export function sortBoards(boards: BoardInfo[]): BoardInfo[] {
  const ms = (b: BoardInfo) => Date.parse(b.updatedAt || b.createdAt) || 0;
  return [...boards].sort((a, b) => Number(a.status !== 'active') - Number(b.status !== 'active') || ms(b) - ms(a));
}

/** A board's title for chrome that has only its id (a dock tab, a header button). */
export function useBoardTitle(boardId: string): string | null {
  const trpc = useTRPC();
  const query = useQuery({ ...trpc.boards.get.queryOptions({ boardId }), retry: false });
  return query.data?.title ?? null;
}
