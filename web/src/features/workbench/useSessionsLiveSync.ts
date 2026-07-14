import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/lib/trpc';

/**
 * Rail-wide session running-state live-sync. Opens one UNSCOPED SSE subscription on
 * `session.status` (no sessionId filter — the center chat's subscription only covers the
 * selected session) and invalidates `sessions.list` on each turn start/end, so every row's
 * running dot (SessionInfo.running snapshot) re-fetches live. Mirrors useThreadsLiveSync.
 */
export function useSessionsLiveSync(): void {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();

  useEffect(() => {
    const sub = client.subscribe.subscribe(
      { events: ['session.status'] },
      {
        onData: () => {
          queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
        },
      },
    );
    return () => sub.unsubscribe();
  }, [client, queryClient, trpc]);
}
