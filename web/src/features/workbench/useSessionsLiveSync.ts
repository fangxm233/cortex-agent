import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/lib/trpc';

/**
 * Rail-wide session running-state live-sync. Opens one UNSCOPED SSE subscription on
 * `session.status` + `session.interaction` (no sessionId filter — the center chat's subscription
 * only covers the selected session) and invalidates `sessions.list` on each turn start/end AND on
 * any interaction create/resolve, so every row's running dot (SessionInfo.running) AND the amber
 * awaiting-input dot (SessionInfo.awaitingInput) re-fetch live. Mirrors useThreadsLiveSync.
 */
export function useSessionsLiveSync(): void {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();

  useEffect(() => {
    const sub = client.subscribe.subscribe(
      { events: ['session.status', 'session.interaction'] },
      {
        onData: () => {
          queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
        },
      },
    );
    return () => sub.unsubscribe();
  }, [client, queryClient, trpc]);
}
