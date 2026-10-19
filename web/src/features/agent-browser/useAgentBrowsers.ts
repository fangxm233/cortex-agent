import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { listAgentBrowsers, type AgentBrowserSession } from './agent-browser-api';
import { pollIntervalMs } from './stream-model';

// Which sessions hold a browser, read off the server. There is no event for it, so it is polled —
// but only while it can change something on screen: fast while a session runs or its browser is in
// view, slowly while a lease just sits there, and never for a session that has none. Every reader
// shares one query, so the header, the dock tab and the palette never fetch it twice. A hidden
// window stops polling (react-query's background default).

export const AGENT_BROWSERS_KEY = ['agent-browser', 'sessions'] as const;

export function useAgentBrowsers({ enabled = true, interval = false }: { enabled?: boolean; interval?: number | false } = {}) {
  return useQuery({
    queryKey: AGENT_BROWSERS_KEY,
    queryFn: listAgentBrowsers,
    enabled,
    refetchInterval: interval,
    staleTime: 1000,
    retry: false,
  });
}

/** One session's browser, polled as fast as its situation warrants. Null while it has none. */
export function useAgentBrowser(sessionId: string | null, { running = false, viewing = false }: { running?: boolean; viewing?: boolean } = {}): AgentBrowserSession | null {
  const query = useQuery({
    queryKey: AGENT_BROWSERS_KEY,
    queryFn: listAgentBrowsers,
    enabled: sessionId !== null,
    staleTime: 1000,
    retry: false,
    refetchInterval: (q) => pollIntervalMs({
      visible: true,
      running,
      viewing,
      hasLease: !!q.state.data?.some((s) => s.sessionId === sessionId),
      held: !!q.state.data?.some((s) => s.sessionId === sessionId && s.takenOver),
    }),
  });
  return query.data?.find((s) => s.sessionId === sessionId) ?? null;
}

/** Patch one session's record in the shared list after an action, ahead of the next poll. */
export function usePatchAgentBrowser(): (sessionId: string, patch: Partial<AgentBrowserSession>) => void {
  const client = useQueryClient();
  return useCallback((sessionId, patch) => {
    client.setQueryData<AgentBrowserSession[]>(AGENT_BROWSERS_KEY, (list) =>
      list?.map((s) => (s.sessionId === sessionId ? { ...s, ...patch } : s)));
  }, [client]);
}
