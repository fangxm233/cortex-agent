// input:  Shared live events and the commission query caches
// output: Commission list/detail/decision invalidation on registry changes
// pos:    Live synchronization hook for commission surfaces
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { COMMISSION_LIVE_EVENTS } from '@/features/live/live-events';

/** Invalidate every commission query after an approval landing, decision projection, or close. */
export function useCommissionLiveSync(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(COMMISSION_LIVE_EVENTS, () => {
    void queryClient.invalidateQueries(trpc.commissions.list.queryFilter());
    void queryClient.invalidateQueries(trpc.commissions.get.queryFilter());
    void queryClient.invalidateQueries(trpc.commissions.decisions.queryFilter());
  });
}
