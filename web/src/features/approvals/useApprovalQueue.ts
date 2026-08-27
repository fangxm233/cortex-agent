// input:  pending approval query, decision requests, feedback drafts, and query cache
// output: shared approval entries, approve/reject operations, pending state, and list refresh
// pos:    Headless desktop/mobile approval queue controller
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';

export interface ApprovalQueue {
  entries: ApprovalInfo[];
  approve: (id: string) => Promise<void>;
  reject: (id: string, feedback?: string) => Promise<void>;
  isPending: boolean;
}

export interface ApprovalQueueOptions {
  /** Lets a conditionally visible surface retain hook order without loading while hidden. */
  enabled?: boolean;
}

/** Owns only the server-backed pending queue and its decision/cache protocol. */
export function useApprovalQueue({ enabled = true }: ApprovalQueueOptions = {}): ApprovalQueue {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const list = useQuery({
    ...trpc.approvals.list.queryOptions({ status: 'pending' }),
    enabled,
  });
  const invalidate = () => queryClient.invalidateQueries(trpc.approvals.list.queryFilter());
  const approveMutation = useMutation(
    trpc.approvals.approve.mutationOptions({ onSettled: invalidate }),
  );
  const rejectMutation = useMutation(
    trpc.approvals.reject.mutationOptions({ onSettled: invalidate }),
  );

  const approve = async (id: string): Promise<void> => {
    await approveMutation.mutateAsync({ id });
  };
  const reject = async (id: string, feedback = ''): Promise<void> => {
    await rejectMutation.mutateAsync({ id, feedback: feedback.trim() || undefined });
  };

  return {
    entries: list.data ?? [],
    approve,
    reject,
    isPending: approveMutation.isPending || rejectMutation.isPending,
  };
}
