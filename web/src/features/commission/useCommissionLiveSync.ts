import { useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLiveEvents } from '@/features/live/LiveEventsProvider';
import { COMMISSION_LIVE_EVENTS } from '@/features/live/live-events';

/**
 * Invalidate every commission query after an approval landing, decision projection, or close.
 *
 * The session list goes with them: `commissionId` / `commissionDraft` live on the SESSION record,
 * so the composer capsule, the chat banner and the rail's commission grouping all read it from
 * there. Without this the capsule kept saying "off" until something else happened to refetch —
 * which was tolerable while the mode could only be chosen at creation, and is not now that a live
 * session can be switched into it by either side (DR-0037 v4).
 */
export function useCommissionLiveSync(): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useLiveEvents(COMMISSION_LIVE_EVENTS, () => {
    void queryClient.invalidateQueries(trpc.commissions.list.queryFilter());
    void queryClient.invalidateQueries(trpc.commissions.get.queryFilter());
    void queryClient.invalidateQueries(trpc.commissions.decisions.queryFilter());
    void queryClient.invalidateQueries(trpc.sessions.list.queryFilter());
  });
}
