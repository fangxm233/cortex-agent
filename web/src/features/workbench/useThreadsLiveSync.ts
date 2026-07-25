import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { THREAD_LIVE_EVENTS } from '@/features/live/live-events';

/**
 * Listen for thread lifecycle events on the SHARED live stream (`features/live/LiveEventsProvider`)
 * and invalidate the `threads.list` query on each, so the workbench Threads tab re-fetches live after
 * a daemon-routed thread transition. Any of `thread.created/step.started/step.finished/completed/
 * failed` can change what `threads.list` returns for the current Active/History scope. Mirrors
 * features/tasks/useTasksLiveSync.
 */
export function useThreadsLiveSync(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(THREAD_LIVE_EVENTS, () => {
    queryClient.invalidateQueries(trpc.threads.list.queryFilter());
  });
}
