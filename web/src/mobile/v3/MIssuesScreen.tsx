// 24c 移动端 Issues — the project issue list, drilled from the 项目 page's Issues card (24a → 24c).
// A non-Tab drill page (the shell hides the Tab bar); back returns to the project page. Wired to the
// REAL `issues.*` ui-service scope: `issues.list({projectId})` feeds the list; `issues.delete`
// removes the entry from the project's ISSUES.md; `issues.handle` creates a NEW direct session
// carrying the issue full text (then removes the entry) and this screen drills straight into the
// created chat (design: 处理 = 新建会话携带此 issue). First card expanded for an inline decision;
// tapping a collapsed card swaps which one is expanded (same interaction as 1f approvals).
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { IssueInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { useMobileProject } from '@/mobile/current-project';
import { MIssuesView, type MIssuesCopy } from './MIssuesView';
import { buildMIssuesVm } from './m-issues-vm';

const COPY: { en: MIssuesCopy; zh: MIssuesCopy } = {
  en: {
    title: 'Issues',
    del: 'Delete',
    handle: 'Handle',
    empty: 'No issues',
    footer: 'Handle = new session carrying this issue · handle / delete removes it',
  },
  zh: {
    title: 'Issues',
    del: '删除',
    handle: '处理',
    empty: '没有 issue',
    footer: '处理 = 新建会话携带此 issue · 处理 / 删除后即离场',
  },
};

export function MIssuesScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const { currentProjectId } = useMobileProject();

  const listQuery = useQuery({
    ...trpc.issues.list.queryOptions({ projectId: currentProjectId ?? '' }),
    enabled: !!currentProjectId,
  });
  const entries = useMemo<IssueInfo[]>(() => listQuery.data ?? [], [listQuery.data]);
  const vm = useMemo(() => buildMIssuesVm(entries), [entries]);

  // Which card is expanded — default to the first; keep valid as the list re-invalidates.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => {
    setExpandedId((cur) =>
      cur && vm.cards.some((c) => c.id === cur) ? cur : vm.cards[0]?.id ?? null,
    );
  }, [vm.cards]);

  const invalidate = () => queryClient.invalidateQueries(trpc.issues.list.queryFilter());
  const del = useMutation(trpc.issues.delete.mutationOptions({ onSettled: invalidate }));
  const handle = useMutation(
    trpc.issues.handle.mutationOptions({
      onSuccess: (data) => navigate(`/m/session/${data.sessionId}`),
      onSettled: invalidate,
    }),
  );
  const busy = del.isPending || handle.isPending;

  return (
    <MIssuesView
      vm={vm}
      copy={copy}
      expandedId={expandedId}
      busy={busy}
      onBack={() => navigate('/m/project')}
      onExpand={setExpandedId}
      onDelete={(id) => currentProjectId && del.mutate({ projectId: currentProjectId, id })}
      onHandle={(id) => currentProjectId && handle.mutate({ projectId: currentProjectId, id })}
    />
  );
}
