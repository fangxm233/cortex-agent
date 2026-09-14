import { useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { SessionInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';

type SessionOrigin = 'direct' | 'scheduled';

export function filterProjectSessions(
  sessions: SessionInfo[],
  projectId: string | null,
): SessionInfo[] {
  if (!projectId) return sessions;
  return sessions.filter((session) => session.projectId === projectId);
}

export function useAllSessions(origin: SessionOrigin) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.sessions.list.queryOptions({ origin }),
    refetchOnMount: false,
  });
}

export function useProjectSessions(projectId: string | null, origin: SessionOrigin) {
  const trpc = useTRPC();
  const select = useCallback(
    (sessions: SessionInfo[]) => filterProjectSessions(sessions, projectId),
    [projectId],
  );
  return useQuery({
    ...trpc.sessions.list.queryOptions({ origin }),
    select,
    refetchOnMount: false,
  });
}
