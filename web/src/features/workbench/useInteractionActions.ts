// Interaction actions for transcript-inline cards (web-interactions-redesign). No local card
// state: the card IS a transcript row; answering/approving just fires the mutation and
// refetches the authoritative transcript. 'already-resolved' (another client / Slack / timeout
// won the race) and NOT_FOUND both settle the same way — refetch, which shows the final state.

import { useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';

export interface InteractionActions {
  answerQuestion: (requestId: string, questions: { question: string }[], optionLabel: string) => void;
  approvePlan: (requestId: string) => void;
  rejectPlan: (requestId: string, feedback?: string) => void;
  busy: boolean;
}

export function useInteractionActions(sessionId: string): InteractionActions {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const answerMut = useMutation(trpc.sessions.answerQuestion.mutationOptions());
  const respondMut = useMutation(trpc.sessions.respondPlan.mutationOptions());

  const refresh = useCallback(() => {
    queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
    queryClient.invalidateQueries(trpc.sessions.pendingInteraction.queryFilter());
  }, [queryClient, trpc, sessionId]);

  const answerQuestion = useCallback((requestId: string, questions: { question: string }[], optionLabel: string) => {
    if (answerMut.isPending) return;
    const answers: Record<string, string> = {};
    for (const q of questions) answers[q.question] = optionLabel;
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

  return { answerQuestion, approvePlan, rejectPlan, busy: answerMut.isPending || respondMut.isPending };
}
