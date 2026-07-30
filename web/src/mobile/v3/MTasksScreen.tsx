// input:  Task query, complete mobile grouping, and navigation
// output: Complete grouped mobile Tasks tab or loading screen
// pos:    Mobile task-list data container
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { pickCopy } from '@/mobile/ui/format';
import { projectInitials } from '@/features/workbench/session-groups';
import { useTasksLiveSync } from '@/features/tasks/useTasksLiveSync';
import { useMobileProject } from '@/mobile/current-project';
import { groupMobileTasks } from '@/mobile/mobile-tasks';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MTasksView, type MTasksCopy } from './MTasksView';
import { buildMTaskGroups } from './m-tasks-vm';

const COPY: { en: MTasksCopy; zh: MTasksCopy } = {
  en: {
    title: 'Tasks', inProgress: 'In progress', actionable: 'Actionable',
    approvalNeeded: 'Approval needed', waiting: 'Waiting', blocked: 'Blocked',
    claim: 'claimed', needs: 'needs', doneWhen: 'done-when',
    doneWhenGap: 'no done-when recorded', openApprovals: 'open approvals',
    done: 'Done', empty: 'No tasks',
  },
  zh: {
    title: '任务', inProgress: '进行中', actionable: '可执行',
    approvalNeeded: '需要审批', waiting: '等待', blocked: '阻塞',
    claim: '认领', needs: '依赖', doneWhen: 'done-when',
    doneWhenGap: 'done-when 未记录', openApprovals: '打开审批',
    done: '完成', empty: '暂无任务',
  },
};

function useExpandedTasks() {
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) => setExpandedIds((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  return { expandedIds, toggle };
}

function useMobileTaskGroups(projectId: string | null) {
  const trpc = useTRPC();
  useTasksLiveSync();
  const query = useQuery(trpc.tasks.list.queryOptions({ projectId: projectId ?? undefined }));
  const tasks = query.data ?? [];
  const groups = useMemo(() => buildMTaskGroups(groupMobileTasks(tasks)), [tasks]);
  return { query, groups };
}

export function MTasksScreen() {
  const navigate = useNavigate();
  const copy = pickCopy(useLang(), COPY);
  const { currentProjectId } = useMobileProject();
  const { query, groups } = useMobileTaskGroups(currentProjectId);
  const expanded = useExpandedTasks();
  const scope = currentProjectId ? projectInitials(currentProjectId) : undefined;

  if (query.isLoading) {
    return <MScreen label="1d 任务"><div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.empty}</div></MScreen>;
  }
  return (
    <MTasksView
      groups={groups}
      scope={scope}
      copy={copy}
      expandedIds={expanded.expandedIds}
      onToggleExpand={expanded.toggle}
      onOpenTask={(id) => navigate(`/m/task/${id}`)}
      onOpenThread={(threadId) => navigate(`/m/thread/${threadId}`)}
      onOpenApprovals={() => navigate('/m/approvals')}
    />
  );
}
