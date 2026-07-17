// Live `session.askUser` + `session.planApproval` stream for the chat surface. Opens one SSE
// subscription scoped to `sessionId` and maps the events to the card data shapes the mobile
// MChatView (1m/1n) already renders. User responses route through the new tRPC mutations
// `sessions.answerQuestion` / `sessions.respondPlan` which resolve the blocked MCP tool on
// the server.

import { useEffect, useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import type { AskQuestionCardData, PlanCardData } from '@/mobile/v3/m-chat-vm';

export interface SessionInteractionsState {
  pendingQuestion: AskQuestionCardData | null;
  pendingPlan: PlanCardData | null;
  onAnswerQuestion: (optionLabel: string) => void;
  onApprovePlan: () => void;
  onRejectPlan: () => void;
}

interface RawAskUserPayload {
  sessionId?: string;
  requestId?: string;
  questions?: { question: string; header: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[];
}

interface RawPlanPayload {
  sessionId?: string;
  requestId?: string;
  planContent?: string;
  planFilePath?: string | null;
}

export function useSessionInteractions(sessionId: string): SessionInteractionsState {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const [pendingQuestion, setPendingQuestion] = useState<(AskQuestionCardData & { _requestId: string; _questions: { question: string }[] }) | null>(null);
  const [pendingPlan, setPendingPlan] = useState<(PlanCardData & { _requestId: string }) | null>(null);

  const answerMut = useMutation(trpc.sessions.answerQuestion.mutationOptions({
    onSuccess: () => setPendingQuestion(null),
  }));
  const respondMut = useMutation(trpc.sessions.respondPlan.mutationOptions({
    onSuccess: () => setPendingPlan(null),
  }));

  useEffect(() => {
    setPendingQuestion(null);
    setPendingPlan(null);
    if (!sessionId) return;

    const sub = client.subscribe.subscribe(
      { events: ['session.askUser', 'session.planApproval'], sessionId },
      {
        onData: (raw: { type?: string; payload?: unknown }) => {
          if (raw.type === 'session.askUser') {
            const p = raw.payload as RawAskUserPayload | undefined;
            if (!p?.requestId || !p.questions?.length) return;
            const questions = p.questions;
            const firstQ = questions[0];
            const card: AskQuestionCardData & { _requestId: string; _questions: { question: string }[] } = {
              id: p.requestId.slice(0, 8),
              question: firstQ.question,
              ttlLabel: null,
              options: (firstQ.options ?? []).map((o, i) => ({
                id: String(i),
                label: o.label,
                isDefault: i === 0,
                meta: o.description,
              })),
              source: '',
              _requestId: p.requestId,
              _questions: questions,
            };
            setPendingQuestion(card);
            return;
          }
          if (raw.type === 'session.planApproval') {
            const p = raw.payload as RawPlanPayload | undefined;
            if (!p?.requestId) return;
            const content = p.planContent ?? '';
            const lines = content.split('\n').filter(Boolean);
            const card: PlanCardData & { _requestId: string } = {
              title: lines[0] || 'Plan',
              estimateLabel: null,
              steps: lines.slice(1, 6).map((text, i) => ({ n: i + 1, text })),
              writePath: p.planFilePath ?? undefined,
              _requestId: p.requestId,
            };
            setPendingPlan(card);
            return;
          }
        },
      },
    );

    return () => sub.unsubscribe();
  }, [client, sessionId]);

  const onAnswerQuestion = useCallback((optionLabel: string) => {
    if (!pendingQuestion || answerMut.isPending) return;
    // Build answers map: question text → selected option label.
    // For a single-question card, the first question maps to the chosen label.
    // For free-text (no options), optionLabel IS the typed text.
    const answers: Record<string, string> = {};
    for (const q of pendingQuestion._questions) {
      answers[q.question] = optionLabel;
    }
    answerMut.mutate({ requestId: pendingQuestion._requestId, answers });
  }, [pendingQuestion, answerMut]);

  const onApprovePlan = useCallback(() => {
    if (!pendingPlan || respondMut.isPending) return;
    respondMut.mutate({ requestId: pendingPlan._requestId, approved: true });
  }, [pendingPlan, respondMut]);

  const onRejectPlan = useCallback(() => {
    if (!pendingPlan || respondMut.isPending) return;
    // For now, reject with empty feedback. A proper UI could show a text input.
    respondMut.mutate({ requestId: pendingPlan._requestId, approved: false, feedback: '' });
  }, [pendingPlan, respondMut]);

  return {
    pendingQuestion: pendingQuestion as AskQuestionCardData | null,
    pendingPlan: pendingPlan as PlanCardData | null,
    onAnswerQuestion,
    onApprovePlan,
    onRejectPlan,
  };
}
