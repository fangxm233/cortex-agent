// input:  approval queue, project scope and approvalId route target
// output: route-selected approvals and optional reject feedback
// pos:    Mobile approvals routing and interaction controller
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

// 1f 审批 — the approval queue, drilled from the project page's amber bar (scheme 1e→1f). A non-Tab
// drill page (the shell hides the Tab bar for /m/approvals); back returns to the project page. Wired to
// the REAL `approvals.*` ui-service scope: `approvals.list({status:'pending'})` feeds the queue, and
// `approvals.approve` / `approvals.reject` flip the target entry's Status line in PENDING_APPROVALS.md
// (the mutate never runs the underlying op) → the list re-invalidates. The first pending card is
// expanded for an inline decision; tapping a collapsed card swaps which one is expanded.
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useCurrentProject } from '@/features/projects/CurrentProjectProvider';
import { defaultSelectedId } from '@/features/approvals/approval-center-vm';
import { useApprovalQueue } from '@/features/approvals/useApprovalQueue';
import { MApprovalsView, type MApprovalsCopy } from './MApprovalsView';
import { buildMApprovalsVm } from './m-approvals-vm';
import { notificationTargetId } from './m-notification-routing';

const COPY: { en: MApprovalsCopy; zh: MApprovalsCopy } = {
  en: {
    title: 'Approvals',
    toProcess: 'pending',
    tier: 'Approval',
    from: 'from',
    paused: 'thread paused, waiting',
    approve: 'Approve',
    reject: 'Reject with feedback',
    feedbackPlaceholder: 'Optional feedback',
    seeDiff: 'tap for diff ›',
    empty: 'No pending approvals',
    globalGroup: 'GLOBAL',
  },
  zh: {
    title: '审批',
    toProcess: '待处理',
    tier: '审批',
    from: '来自',
    paused: '线程已暂停等待',
    approve: '批准',
    reject: '拒绝并反馈',
    feedbackPlaceholder: '可选反馈',
    seeDiff: '点开看 diff ›',
    empty: '没有待处理的审批',
    globalGroup: '全局',
  },
};

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
  const copy = pickCopy(useLang(), COPY);
  const queue = useApprovalQueue();
  const { currentProjectId } = useCurrentProject();
  const vm = useMemo(
    () => buildMApprovalsVm(queue.entries, Date.now(), currentProjectId),
    [queue.entries, currentProjectId],
  );
  const selection = useRouteExpansion(vm.cards);
  return <MApprovalsView
    vm={vm} copy={copy} expandedId={selection.expandedId} feedback={selection.feedback}
    busy={queue.isPending} onBack={() => navigate('/m/project')}
    onExpand={selection.expand} onFeedback={selection.setFeedback}
    onApprove={(id) => selection.settle(queue.approve(id))}
    onReject={(id, draft) => selection.settle(queue.reject(id, draft))}
  />;
}
