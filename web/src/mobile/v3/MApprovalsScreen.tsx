// 1f 审批 — the approval queue, drilled from the project page's amber bar (scheme 1e→1f). A non-Tab
// drill page (the shell hides the Tab bar for /m/approvals); back returns to the project page. Wired to
// the REAL `approvals.*` ui-service scope: `approvals.list({status:'pending'})` feeds the queue, and
// `approvals.approve` / `approvals.reject` flip the target entry's Status line in PENDING_APPROVALS.md
// (the mutate never runs the underlying op) → the list re-invalidates. The first pending card is
// expanded for an inline decision; tapping a collapsed card swaps which one is expanded.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { ApprovalInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { MApprovalsView, type MApprovalsCopy } from './MApprovalsView';
import { buildMApprovalsVm } from './m-approvals-vm';

const COPY: { en: MApprovalsCopy; zh: MApprovalsCopy } = {
  en: {
    title: 'Approvals',
    toProcess: 'pending',
    tier: 'Approval',
    from: 'from',
    paused: 'thread paused, waiting',
    approve: 'Approve',
    reject: 'Reject with feedback',
    seeDiff: 'tap for diff ›',
    empty: 'No pending approvals',
  },
  zh: {
    title: '审批',
    toProcess: '待处理',
    tier: '审批',
    from: '来自',
    paused: '线程已暂停等待',
    approve: '批准',
    reject: '拒绝并反馈',
    seeDiff: '点开看 diff ›',
    empty: '没有待处理的审批',
  },
};

export function MApprovalsScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);

  const listQuery = useQuery(trpc.approvals.list.queryOptions({ status: 'pending' }));
  const entries = useMemo<ApprovalInfo[]>(() => listQuery.data ?? [], [listQuery.data]);
  const vm = useMemo(() => buildMApprovalsVm(entries), [entries]);

  // Which card is expanded — default to the first pending; keep valid as the list re-invalidates.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    setExpandedId((cur) =>
      cur && vm.cards.some((c) => c.id === cur) ? cur : vm.cards[0]?.id ?? null,
    );
  }, [vm.cards]);

  const invalidate = () => queryClient.invalidateQueries(trpc.approvals.list.queryFilter());
  const approve = useMutation(trpc.approvals.approve.mutationOptions({ onSettled: invalidate }));
  const reject = useMutation(trpc.approvals.reject.mutationOptions({ onSettled: invalidate }));
  const busy = approve.isPending || reject.isPending;

  return (
    <MApprovalsView
      vm={vm}
      copy={copy}
      expandedId={expandedId}
      busy={busy}
      onBack={() => navigate('/m/project')}
      onExpand={setExpandedId}
      onApprove={(id) => approve.mutate({ id })}
      onReject={(id) => reject.mutate({ id })}
    />
  );
}
