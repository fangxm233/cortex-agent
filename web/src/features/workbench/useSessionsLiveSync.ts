import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';

/**
 * Rail-wide session running-state live-sync. Listens on the SHARED live stream
 * (`features/live/LiveEventsProvider` — one SSE for the whole app) for `session.status` +
 * `session.interaction`, UNSCOPED (the center chat's listener only covers the selected session), and
 * invalidates `sessions.list` on each turn start/end AND on any interaction create/resolve, so every
 * row's running dot (SessionInfo.running) AND the amber awaiting-input dot (SessionInfo.awaitingInput)
 * re-fetch live. Mirrors useThreadsLiveSync.
 */
const RAIL_EVENTS = ['session.status', 'session.interaction'];

export function useSessionsLiveSync(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(RAIL_EVENTS, () => {
    queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
  });
}
