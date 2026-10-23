import { mobileHeaderBack } from '@/mobile/mobile-navigation';
// 1f 审批 — the approval queue, drilled from the project panel's amber bar (scheme 1e→1f). A drill
// page; back returns to the project panel. Wired to
// the REAL `approvals.*` ui-service scope: `approvals.list({status:'pending'})` feeds the queue, and
// `approvals.approve` / `approvals.reject` flip the target entry's Status line in PENDING_APPROVALS.md
// (the mutate never runs the underlying op) → the list re-invalidates. The first pending card is
// expanded for an inline decision; tapping a collapsed card swaps which one is expanded. Sessions'
// pending plan approvals are listed and counted too; tapping one opens its plan page to decide.
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang } from '@/i18n';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { defaultSelectedId } from '@/features/approvals/approval-center-vm';
import { useApprovalQueue } from '@/features/approvals/useApprovalQueue';
import { MApprovalsView } from './MApprovalsView';
import { buildMApprovalsVm } from './m-approvals-vm';
import { usePendingPlans } from './usePendingPlans';
import { notificationTargetId } from './m-notification-routing';

// Expansion and feedback belong to the mobile surface, not the shared queue.
function useRouteExpansion(cards: ReturnType<typeof buildMApprovalsVm>['cards']) {
  const location = useLocation();
  const targetId = notificationTargetId(new URLSearchParams(location.search).get('approvalId')) ?? null;
  const [rawExpandedId, setRawExpandedId] = useState<string | null>(targetId);
  const [feedback, setFeedback] = useState('');
  useEffect(() => {
    setRawExpandedId(targetId);
    setFeedback('');
  }, [targetId, location.key]);
  const expandedId = defaultSelectedId(cards, rawExpandedId);
  const expand = (id: string) => {
    setFeedback('');
    setRawExpandedId(id);
  };
  const settle = (decision: Promise<void>) => {
    void decision.catch(() => undefined).finally(() => setFeedback(''));
  };

  return { expandedId, feedback, expand, setFeedback, settle };
}

export function MApprovalsScreen() {
  const navigate = useNavigate();
  const lang = useLang();
  const queue = useApprovalQueue();
  const plans = usePendingPlans();
  const { currentProjectId } = useCurrentProject();
  const vm = useMemo(
    () => buildMApprovalsVm(queue.entries, Date.now(), currentProjectId, lang, plans),
    [queue.entries, currentProjectId, lang, plans],
  );
  const selection = useRouteExpansion(vm.cards);
  return <MApprovalsView
    vm={vm} expandedId={selection.expandedId} feedback={selection.feedback}
    busy={queue.isPending} onBack={() => mobileHeaderBack(navigate, '/m/project')}
    onExpand={selection.expand} onFeedback={selection.setFeedback}
    onApprove={(id) => selection.settle(queue.approve(id))}
    onReject={(id, draft) => selection.settle(queue.reject(id, draft))}
    onOpenPlan={(plan) => navigate(`/m/session/${plan.sessionId}/plan/${plan.requestId}`)}
  />;
}
