import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import type { BoardInfo, SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { boardBodyPath, boardDir, LEGACY_BOARD_FILES } from './board-paths';

export type BoardBodyState =
  | { kind: 'loading' }
  | { kind: 'body'; html: string }
  /** No board.html: the board predates bodies. `files` are the legacy files that exist. */
  | { kind: 'empty'; files: string[] };

/** What the live surfaces show: the board, its bound sessions and its decisions. */
export interface BoardLive {
  board: BoardInfo | null;
  /** The board query failed or the board is gone. */
  missing: boolean;
  decisions: ReturnType<typeof useBoardDecisions>;
  /** Sessions bound to this board, from the shared session list. */
  sessions: SessionInfo[];
}

export interface BoardData extends BoardLive {
  body: BoardBodyState;
  style: { defaultCss: string; userCss: string | null } | null;
}

function useBoardDecisions(boardId: string) {
  const trpc = useTRPC();
  return useQuery(trpc.boards.decisions.queryOptions({ boardId })).data ?? [];
}

/** The board's live state, shared by the dock's strip and the chat's status bar. */
export function useBoardLive(boardId: string): BoardLive {
  const trpc = useTRPC();
  const boardQuery = useQuery({ ...trpc.boards.get.queryOptions({ boardId }), retry: false });
  const sessionsQuery = useQuery({ ...trpc.sessions.list.queryOptions({}), refetchOnMount: false });
  const decisions = useBoardDecisions(boardId);
  const sessions = useMemo(
    () => (sessionsQuery.data ?? []).filter((s) => s.boardId === boardId),
    [sessionsQuery.data, boardId],
  );
  const board = boardQuery.data ?? null;
  return { board, missing: boardQuery.isError && !board, decisions, sessions };
}

export function useBoard(boardId: string): BoardData {
  const trpc = useTRPC();
  const live = useBoardLive(boardId);
  const { board } = live;
  const styleQuery = useQuery({ ...trpc.boards.style.queryOptions({}), staleTime: Infinity });

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

  let body: BoardBodyState = { kind: 'loading' };
  if (bodyQuery.data) body = { kind: 'body', html: bodyQuery.data.content };
  else if (bodyMissing && legacy.every((q) => !q.isLoading)) {
    body = { kind: 'empty', files: LEGACY_BOARD_FILES.filter((_, i) => !!legacy[i]?.data) };
  }

  return { ...live, body, style: styleQuery.data ?? null };
}

/** A board's title for chrome that has only its id (a dock tab). */
export function useBoardTitle(boardId: string): string | null {
  const trpc = useTRPC();
  const query = useQuery({ ...trpc.boards.get.queryOptions({ boardId }), retry: false });
  return query.data?.title ?? null;
}
