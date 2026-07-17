// Live `session.askUser` + `session.planApproval` stream for the chat surface. Opens one SSE
// subscription scoped to `sessionId` and maps the events to the card data shapes the mobile
// MChatView (1m/1n) already renders. User responses route through the new tRPC mutations
// `sessions.answerQuestion` / `sessions.respondPlan` which resolve the blocked MCP tool on
// the server.
//
// State is cached in a module-level Map keyed by sessionId so it survives navigation within
// the SPA (e.g. switching tabs on mobile then returning to the chat). The SSE subscription
// re-establishes on mount; pending interactions are hydrated from the cache.

import { useEffect, useState, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
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

// ── Module-level cache (survives navigation within the SPA) ──────────────────

interface InteractionCache {
  pendingQuestion: (AskQuestionCardData & { _requestId: string; _questions: { question: string }[] }) | null;
  pendingPlan: (PlanCardData & { _requestId: string }) | null;
  answered: AnsweredQuestionRow[];
}

const cache = new Map<string, InteractionCache>();

function getCache(sessionId: string): InteractionCache {
  let c = cache.get(sessionId);
  if (!c) {
    c = { pendingQuestion: null, pendingPlan: null, answered: [] };
    cache.set(sessionId, c);
  }
  return c;
}

// ── Event payload types ──────────────────────────────────────────────────────

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

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useSessionInteractions(sessionId: string): SessionInteractionsState {
  const trpc = useTRPC();
  const client = useTRPCClient();

  // Hydrate from cache on mount / session switch.
  const cached = sessionId ? getCache(sessionId) : null;
  const [pendingQuestion, setPendingQuestion] = useState<InteractionCache['pendingQuestion']>(cached?.pendingQuestion ?? null);
  const [pendingPlan, setPendingPlan] = useState<InteractionCache['pendingPlan']>(cached?.pendingPlan ?? null);
  const [answered, setAnswered] = useState<AnsweredQuestionRow[]>(cached?.answered ?? []);

  // Sync state → cache on every change.
  useEffect(() => {
    if (!sessionId) return;
    const c = getCache(sessionId);
    c.pendingQuestion = pendingQuestion;
    c.pendingPlan = pendingPlan;
    c.answered = answered;
  }, [sessionId, pendingQuestion, pendingPlan, answered]);

  const answerMut = useMutation(trpc.sessions.answerQuestion.mutationOptions());
  const respondMut = useMutation(trpc.sessions.respondPlan.mutationOptions());

  useEffect(() => {
    // Hydrate from cache (may have state from a previous mount).
    const c = sessionId ? getCache(sessionId) : null;
    setPendingQuestion(c?.pendingQuestion ?? null);
    setPendingPlan(c?.pendingPlan ?? null);
    setAnswered(c?.answered ?? []);
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
            const card: InteractionCache['pendingQuestion'] = {
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
            const card: InteractionCache['pendingPlan'] = {
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
        },
      },
    );
  }, [pendingQuestion, answerMut]);

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
        },
      },
    );
  }, [pendingPlan, respondMut]);

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
        },
      },
    );
  }, [pendingPlan, respondMut]);

  return {
    pendingQuestion: pendingQuestion as AskQuestionCardData | null,
    pendingPlan: pendingPlan as PlanCardData | null,
    answeredQuestions: answered,
    onAnswerQuestion,
    onApprovePlan,
    onRejectPlan,
  };
}
