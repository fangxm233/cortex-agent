import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { TASK_LIVE_EVENTS } from '@/features/live/live-events';

/**
 * Listen for task lifecycle events on the SHARED live stream (`features/live/LiveEventsProvider`) and
 * invalidate the `tasks.list` query on each, so the Tasks tab re-fetches and re-renders live after a
 * mutation routed through the daemon (query→mutate→event→invalidate→refetch). unclaim/unblock are
 * deliberately absent — the CortexEvent union has no such events, so they cannot drive a live refresh.
 */
export function useTasksLiveSync(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(TASK_LIVE_EVENTS, () => {
    queryClient.invalidateQueries(trpc.tasks.list.queryFilter());
  });
}
