import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { DecisionActionKind } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';

// The decision rows' actions (mirror of useInteractionActions: no local row state, refetch settles).

export interface DecisionActions {
  respond: (decisionId: string, action: DecisionActionKind, message?: string) => void;
  /** Approve several in one go, one request after another, refetching once at the end. */
  approveAll?: (decisionIds: string[]) => void;
  busy: boolean;
}

export function useDecisionActions(sessionId: string): DecisionActions {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mut = useMutation(trpc.sessions.respondDecision.mutationOptions());

  const refresh = useCallback(() => {
    queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
  }, [queryClient, trpc, sessionId]);

  const respond = useCallback((decisionId: string, action: DecisionActionKind, message?: string) => {
    if (!sessionId || mut.isPending) return;
    mut.mutate(
      { sessionId, decisionId, action, ...(message ? { message } : {}) },
      { onSettled: refresh },
    );
  }, [sessionId, mut, refresh]);

  const approveAll = useCallback((decisionIds: string[]) => {
    if (!sessionId || mut.isPending || decisionIds.length === 0) return;
    void (async () => {
      for (const decisionId of decisionIds) {
        try {
          await mut.mutateAsync({ sessionId, decisionId, action: 'approve' });
        } catch {
          break;
        }
      }
      refresh();
    })();
  }, [sessionId, mut, refresh]);

  return { respond, approveAll, busy: mut.isPending };
}
