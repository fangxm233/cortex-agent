// input:  Shared live events and light/full threads.get query keys
// output: useThreadGetLiveSync
// pos:    Keeps one expanded thread detail query live
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { TASK_LIVE_EVENTS, THREAD_LIVE_EVENTS } from '@/features/live/live-events';

const THREAD_DETAIL_LIVE_EVENTS = [...THREAD_LIVE_EVENTS, ...TASK_LIVE_EVENTS] as const;

/**
 * Listen for thread and task lifecycle events on the shared stream. Both can change an expanded
 * `threads.get`: thread events move the pipeline, while task events update direct-subtask activity.
 * A card adds one listener to the existing shared SSE connection.
 */
export function useThreadGetLiveSync(threadId: string, includeArtifactContent = false): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const input = includeArtifactContent ? { threadId, includeArtifactContent: true } : { threadId };

  useLiveEvents(THREAD_DETAIL_LIVE_EVENTS, () => {
    queryClient.invalidateQueries(trpc.threads.get.queryFilter(input));
  });
}
