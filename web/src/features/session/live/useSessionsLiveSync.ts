import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';

/**
 * Rail-wide session running-state live-sync. Listens on the SHARED live stream
 * (`features/live/LiveEventsProvider` — one SSE for the whole app) for `session.status` +
 * `session.interaction` + snapshot-bearing context/Todo events, UNSCOPED (the center chat's listener
 * only covers the selected session), and invalidates `sessions.list` so every session snapshot is
 * current before selection.
 */
const RAIL_EVENTS = [
  'session.status', 'session.interaction', 'session.context-usage', 'session.context-compacted',
  'session.todos', 'session.deleted', 'project.deleted',
];

export function useSessionsLiveSync(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(RAIL_EVENTS, (event) => {
    queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
    if (event.type === 'project.deleted') queryClient.invalidateQueries(trpc.projects.list.queryFilter());
  });
}
