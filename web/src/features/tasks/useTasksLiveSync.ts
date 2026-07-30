// input:  Shared live events and the tasks.list query cache
// output: Task-list invalidation on lifecycle and thread-link changes
// pos:    Live synchronization hook for task list surfaces
// >>> If I am updated, update my header comment and CORTEX.md <<<

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
