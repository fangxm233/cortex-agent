import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { THREAD_LIVE_EVENTS } from '@/features/live/live-events';

/**
 * Listen for thread lifecycle events on the SHARED live stream (`features/live/LiveEventsProvider`)
 * and invalidate the `threads.get` query for `threadId` on each, so the inline thread card re-fetches
 * live after a daemon-routed thread transition. Any of the lifecycle events can change what
 * `threads.get` returns for the open card (a step starts/finishes, the thread ends).
 *
 * This one used to be the worst offender for connection count: every expanded thread card opened its
 * own SSE. On the shared stream a card costs a listener, not a connection.
 */
export function useThreadGetLiveSync(threadId: string): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(THREAD_LIVE_EVENTS, () => {
    queryClient.invalidateQueries(trpc.threads.get.queryFilter({ threadId }));
  });
}
