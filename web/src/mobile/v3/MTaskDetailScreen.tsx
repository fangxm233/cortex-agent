// 1h 任务详情 — a single task's read-only detail, drilled from 1d (scheme-mobile.dc.html 1h L440-484).
// NON-Tab drill page (route :taskId). Editing / dispatch / cancel live on desktop or in chat — this
// page only READS. Real tRPC: `tasks.list` (find the task by id, scoped to the current project, + the
// dependency join) and `tasks.verification` (done-when evidence + the per-task dispatch history that
// backs the claim-thread card and the 历史 rows). The pure mapping lives in m-task-detail-vm; the
// pixels in MTaskDetailView. The shell owns the bottom Tab bar (this page has none).
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc';
import { useLang } from '@/i18n';
import { useTasksLiveSync } from '@/features/tasks/useTasksLiveSync';
import { useMobileProject } from '@/mobile/current-project';
import { MScreen, MC } from '@/mobile/ui/kit';
import { MTaskDetailView, ZH_COPY, EN_COPY } from './MTaskDetailView';
import { buildTaskDetailVm } from './m-task-detail-vm';

export function MTaskDetailScreen() {
  const trpc = useTRPC();
  const navigate = useNavigate();
  const lang = useLang();
  const copy = lang === 'zh' ? ZH_COPY : EN_COPY;
  const { taskId } = useParams<{ taskId: string }>();
  const { currentProjectId } = useMobileProject();

  useTasksLiveSync();
  const tasksQuery = useQuery(
    trpc.tasks.list.queryOptions({ projectId: currentProjectId ?? undefined }),
  );
  const verifyQuery = useQuery({
    ...trpc.tasks.verification.queryOptions({
      projectId: currentProjectId ?? '',
      taskId: taskId ?? '',
    }),
    enabled: !!currentProjectId && !!taskId,
  });

  const tasks = tasksQuery.data ?? [];
  const vm = useMemo(
    () => buildTaskDetailVm(taskId ?? '', tasks, verifyQuery.data ?? null),
    [taskId, tasks, verifyQuery.data],
  );

  if (tasksQuery.isLoading) {
    return (
      <MScreen label="1h 任务详情">
        <div style={{ padding: 16, color: MC.muted, fontSize: 13 }}>{copy.notFound}</div>
      </MScreen>
    );
  }

  return (
    <MTaskDetailView
      vm={vm}
      copy={copy}
      onBack={() => navigate(-1)}
      onOpenThread={(threadId) => navigate(`/m/thread/${threadId}`)}
    />
  );
}
