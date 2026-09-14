import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { TASK_LIST_LIVE_EVENTS } from '@/features/live/live-events';

/** Invalidate tasks.list after task lifecycle changes or creation of its owning thread. */
export function useTasksLiveSync(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(TASK_LIST_LIVE_EVENTS, () => {
    queryClient.invalidateQueries(trpc.tasks.list.queryFilter());
  });
}
