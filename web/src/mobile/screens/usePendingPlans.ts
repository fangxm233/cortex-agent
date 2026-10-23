import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useVocabOptional } from '@/i18n';
import { useTRPC } from '@/lib/trpc';
import { useAllSessions } from '@/features/projects/useProjectSessions';
import { planTitle } from '@/features/session/interaction/interaction-vm';
import { shortSessionId } from '@/features/session/metadata/short-session-id';
import type { MPendingPlan } from './m-approvals-vm';

/** Plan approvals the user's sessions are blocked on, from the same per-session
 *  `sessions.pendingInteraction` lookup the overview makes for sessions awaiting input. */
export function usePendingPlans(): MPendingPlan[] {
  const trpc = useTRPC();
  const L = useVocabOptional();
  const sessions = useAllSessions('direct').data;
  const asking = useMemo(() => (sessions ?? []).filter((s) => s.awaitingInput), [sessions]);
  const results = useQueries({
    queries: asking.map((s) => trpc.sessions.pendingInteraction.queryOptions({ sessionId: s.sessionId })),
  });
  const plans: MPendingPlan[] = [];
  asking.forEach((s, i) => {
    const plan = results[i]?.data?.plan;
    if (!plan) return;
    plans.push({
      sessionId: s.sessionId,
      requestId: plan.requestId,
      projectId: s.projectId || null,
      title: planTitle(plan.planContent, plan.planFilePath, L),
      session: s.label ?? shortSessionId(s.sessionId),
    });
  });
  return plans;
}
