// Actions offered by transcript-inline cards (web-interactions-redesign). No local card
// state: the card IS a transcript row; answering/approving just fires the mutation and
// refetches the authoritative transcript. 'already-resolved' (another client / Slack / timeout
// won the race) and NOT_FOUND both settle the same way — refetch, which shows the final state.

import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

export interface InteractionActions {
  /** Submit the full per-question answer record (multi-select values pre-joined with ", "). */
  answerQuestion: (requestId: string, answers: Record<string, string>) => void;
  approvePlan: (requestId: string) => void;
  rejectPlan: (requestId: string, feedback?: string) => void;
  /** Decline the auto-resume promised after a rate limit interrupted this session. */
  cancelResume: () => void;
  /** True once this session's resume has been declined — the control stays visible but inert. */
  resumeCancelled: boolean;
  busy: boolean;
}

export function useInteractionActions(sessionId: string): InteractionActions {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const answerMut = useMutation(trpc.sessions.answerQuestion.mutationOptions());
  const respondMut = useMutation(trpc.sessions.respondPlan.mutationOptions());
  const cancelResumeMut = useMutation(trpc.sessions.cancelResume.mutationOptions());
  // Keyed by session so switching conversations cannot inherit another one's cancelled state.
  const [cancelledFor, setCancelledFor] = useState<string | null>(null);

  const refresh = useCallback(() => {
    queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
    queryClient.invalidateQueries(trpc.sessions.pendingInteraction.queryFilter());
  }, [queryClient, trpc, sessionId]);

  const answerQuestion = useCallback((requestId: string, answers: Record<string, string>) => {
    if (answerMut.isPending) return;
    answerMut.mutate({ requestId, answers }, { onSettled: refresh });
  }, [answerMut, refresh]);

  const approvePlan = useCallback((requestId: string) => {
    if (respondMut.isPending) return;
    respondMut.mutate({ requestId, approved: true }, { onSettled: refresh });
  }, [respondMut, refresh]);

  const rejectPlan = useCallback((requestId: string, feedback?: string) => {
    if (respondMut.isPending) return;
    respondMut.mutate({ requestId, approved: false, feedback: feedback ?? '' }, { onSettled: refresh });
  }, [respondMut, refresh]);

  const cancelResume = useCallback(() => {
    if (cancelResumeMut.isPending) return;
    cancelResumeMut.mutate({ sessionId }, {
      // Settled either way: a resume that already fired reports cancelled:false, and the control
      // is spent regardless.
      onSettled: () => { setCancelledFor(sessionId); refresh(); },
    });
  }, [cancelResumeMut, refresh, sessionId]);

  return {
    answerQuestion, approvePlan, rejectPlan, cancelResume,
    resumeCancelled: cancelledFor === sessionId,
    busy: answerMut.isPending || respondMut.isPending,
  };
}
