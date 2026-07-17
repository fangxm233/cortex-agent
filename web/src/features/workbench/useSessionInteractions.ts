// Live `session.askUser` + `session.planApproval` stream for the chat surface, with server-side
// hydration via `sessions.pendingInteraction` query. The query runs on mount to catch interactions
// that fired while the app was closed; the SSE subscription handles live arrivals. Answered
// interactions are persisted server-side in conversation-history and appear in the transcript.

import { useEffect, useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import type { AskQuestionCardData, AnsweredQuestionRow, PlanCardData } from '@/mobile/v3/m-chat-vm';

export interface SessionInteractionsState {
  pendingQuestion: AskQuestionCardData | null;
  pendingPlan: PlanCardData | null;
  answeredQuestions: AnsweredQuestionRow[];
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

type PendingQ = AskQuestionCardData & { _requestId: string; _questions: { question: string }[] };
type PendingP = PlanCardData & { _requestId: string };

function mapAskUserToCard(requestId: string, questions: RawAskUserPayload['questions']): PendingQ | null {
  if (!questions?.length) return null;
  const firstQ = questions[0];
  return {
    id: requestId.slice(0, 8),
    question: firstQ.question,
    ttlLabel: null,
    options: (firstQ.options ?? []).map((o, i) => ({
      id: String(i),
      label: o.label,
      isDefault: i === 0,
      meta: o.description,
    })),
    source: '',
    _requestId: requestId,
    _questions: questions,
  };
}

function mapPlanToCard(requestId: string, planContent: string, planFilePath?: string | null): PendingP {
  const lines = planContent.split('\n').filter(Boolean);
  return {
    title: lines[0] || 'Plan',
    estimateLabel: null,
    steps: lines.slice(1, 6).map((text, i) => ({ n: i + 1, text })),
    writePath: planFilePath ?? undefined,
    _requestId: requestId,
  };
}

export function useSessionInteractions(sessionId: string): SessionInteractionsState {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [pendingQuestion, setPendingQuestion] = useState<PendingQ | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingP | null>(null);
  const [answered, setAnswered] = useState<AnsweredQuestionRow[]>([]);

  // Hydrate from server on mount — catches interactions that fired while app was closed.
  const pendingQuery = useQuery({
    ...trpc.sessions.pendingInteraction.queryOptions({ sessionId }),
    enabled: !!sessionId,
  });

  // Hydrate from query result when it arrives (only if no SSE-driven state yet).
  useEffect(() => {
    if (!pendingQuery.data) return;
    const d = pendingQuery.data;
    if (d.askUser && !pendingQuestion) {
      const card = mapAskUserToCard(d.askUser.requestId, d.askUser.questions);
      if (card) setPendingQuestion(card);
    }
    if (d.plan && !pendingPlan) {
      setPendingPlan(mapPlanToCard(d.plan.requestId, d.plan.planContent, d.plan.planFilePath));
    }
  }, [pendingQuery.data]);

  const answerMut = useMutation(trpc.sessions.answerQuestion.mutationOptions());
  const respondMut = useMutation(trpc.sessions.respondPlan.mutationOptions());

  // SSE subscription for live arrivals.
  useEffect(() => {
    setPendingQuestion(null);
    setPendingPlan(null);
    setAnswered([]);
    if (!sessionId) return;

    const sub = client.subscribe.subscribe(
      { events: ['session.askUser', 'session.planApproval'], sessionId },
      {
        onData: (raw: { type?: string; payload?: unknown }) => {
          if (raw.type === 'session.askUser') {
            const p = raw.payload as RawAskUserPayload | undefined;
            if (!p?.requestId || !p.questions?.length) return;
            const card = mapAskUserToCard(p.requestId, p.questions);
            if (card) setPendingQuestion(card);
            return;
          }
          if (raw.type === 'session.planApproval') {
            const p = raw.payload as RawPlanPayload | undefined;
            if (!p?.requestId) return;
            setPendingPlan(mapPlanToCard(p.requestId, p.planContent ?? '', p.planFilePath));
            return;
          }
        },
      },
    );

    return () => sub.unsubscribe();
  }, [client, sessionId]);

  const onAnswerQuestion = useCallback((optionLabel: string) => {
    if (!pendingQuestion || answerMut.isPending) return;
    const answers: Record<string, string> = {};
    for (const q of pendingQuestion._questions) {
      answers[q.question] = optionLabel;
    }
    const summary = `${pendingQuestion.question} → ${optionLabel}`;
    const answeredRow: AnsweredQuestionRow = {
      id: pendingQuestion._requestId,
      summary,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    answerMut.mutate(
      { requestId: pendingQuestion._requestId, answers },
      {
        onSuccess: () => {
          setPendingQuestion(null);
          setAnswered((prev) => [...prev, answeredRow]);
          // Invalidate pending query + transcript so the persisted interaction row appears.
          queryClient.invalidateQueries(trpc.sessions.pendingInteraction.queryFilter());
          queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
        },
      },
    );
  }, [pendingQuestion, answerMut, queryClient, trpc, sessionId]);

  const onApprovePlan = useCallback(() => {
    if (!pendingPlan || respondMut.isPending) return;
    const answeredRow: AnsweredQuestionRow = {
      id: pendingPlan._requestId,
      summary: `${pendingPlan.title} → approved`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    respondMut.mutate(
      { requestId: pendingPlan._requestId, approved: true },
      {
        onSuccess: () => {
          setPendingPlan(null);
          setAnswered((prev) => [...prev, answeredRow]);
          queryClient.invalidateQueries(trpc.sessions.pendingInteraction.queryFilter());
          queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
        },
      },
    );
  }, [pendingPlan, respondMut, queryClient, trpc, sessionId]);

  const onRejectPlan = useCallback(() => {
    if (!pendingPlan || respondMut.isPending) return;
    const answeredRow: AnsweredQuestionRow = {
      id: pendingPlan._requestId,
      summary: `${pendingPlan.title} → rejected`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    respondMut.mutate(
      { requestId: pendingPlan._requestId, approved: false, feedback: '' },
      {
        onSuccess: () => {
          setPendingPlan(null);
          setAnswered((prev) => [...prev, answeredRow]);
          queryClient.invalidateQueries(trpc.sessions.pendingInteraction.queryFilter());
          queryClient.invalidateQueries(trpc.sessions.transcript.queryFilter({ sessionId }));
        },
      },
    );
  }, [pendingPlan, respondMut, queryClient, trpc, sessionId]);

  return {
    pendingQuestion: pendingQuestion as AskQuestionCardData | null,
    pendingPlan: pendingPlan as PlanCardData | null,
    answeredQuestions: answered,
    onAnswerQuestion,
    onApprovePlan,
    onRejectPlan,
  };
}
