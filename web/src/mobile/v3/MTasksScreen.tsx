// 1d 任务 — the current project's task queue (read-only; editing/dispatch is desktop/chat). Scheme
// 1d L240-284. Real tRPC: `tasks.list` scoped to the current project + live-refresh via the shared
// tasks subscription. Groups (进行中/可执行/阻塞) come from the shared `groupMobileTasks` bucketing; the
// 可执行/全部 segment scopes what shows. Rows drill into the task detail (1h); the inline 认领 pill →
// thread (1b), the 阻塞 approval line → approvals. Presentation lives in MTasksView.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import { useTasksLiveSync } from '@/features/tasks/useTasksLiveSync';
import { useMobileProject } from '@/mobile/current-project';
import {
  groupMobileTasks,
  executableCount,
  allOpenCount,
  type MobileSegment,
} from '@/mobile/mobile-tasks';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MTasksView, type MTasksCopy } from './MTasksView';
import { buildMTaskGroups } from './m-tasks-vm';

const COPY: { en: MTasksCopy; zh: MTasksCopy } = {
  en: {
    title: 'Tasks',
    executable: 'Executable',
    all: 'All',
    inProgress: 'In progress',
    claimable: 'Executable',
    blocked: 'Blocked',
    claim: 'claim',
    doneWhen: 'done-when',
    doneWhenGap: 'no done-when recorded',
    waitApproval: 'awaiting approval',
    seeApprovals: 'see project approvals',
    empty: 'No tasks',
  },
  zh: {
    title: '任务',
    executable: '可执行',
    all: '全部',
    inProgress: '进行中',
    claimable: '可执行',
    blocked: '阻塞',
    claim: '认领',
    doneWhen: 'done-when',
    doneWhenGap: 'done-when 未记录',
    waitApproval: '等待审批',
    seeApprovals: '见项目页审批',
    empty: '暂无任务',
  },
};

export function MTasksScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = pickCopy(lang, COPY);
  const { currentProjectId } = useMobileProject();

  useTasksLiveSync();
  const tasksQuery = useQuery(
    trpc.tasks.list.queryOptions({ projectId: currentProjectId ?? undefined }),
  );
  const tasks = tasksQuery.data ?? [];

  const [segment, setSegment] = useState<MobileSegment>('executable');
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  const grouped = useMemo(() => groupMobileTasks(tasks), [tasks]);
  const groups = useMemo(() => buildMTaskGroups(grouped, segment), [grouped, segment]);
  const scope = currentProjectId ? projectInitials(currentProjectId) : undefined;

  const onToggleExpand = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <MScreen label="1d 任务">
      {tasksQuery.isLoading ? (
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div>
      ) : (
        <MTasksView
          groups={groups}
          segment={segment}
          executableCount={executableCount(grouped)}
          allCount={allOpenCount(grouped)}
          scope={scope}
          copy={copy}
          expandedIds={expandedIds}
          onToggleExpand={onToggleExpand}
          onSegment={setSegment}
          onOpenTask={(id) => navigate(`/m/task/${id}`)}
          onOpenThread={(threadId) => navigate(`/m/thread/${threadId}`)}
          onOpenApprovals={() => navigate('/m/approvals')}
        />
      )}
    </MScreen>
  );
}
