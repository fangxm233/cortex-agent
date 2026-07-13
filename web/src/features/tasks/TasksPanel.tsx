import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { groupTasks, type TaskGroup } from './group-tasks';
import { TaskRow } from './TaskRow';
import { TaskModal } from './TaskModal';
import { useTasksLiveSync } from './useTasksLiveSync';

function GroupSection({
  title,
  groups,
  pendingId,
  onUnblock,
  onOpen,
}: {
  title: string;
  groups: TaskGroup[];
  pendingId: string | null;
  onUnblock: (t: TaskInfo) => void;
  onOpen: (t: TaskInfo) => void;
}) {
  const L = useVocab();
  const count = groups.reduce((n, g) => n + g.tasks.length, 0);
  return (
    <section className="mb-3g">
      <h2 className="mb-1g text-ui font-medium uppercase tracking-wide text-state-ink/60">
        {title} <span className="font-mono text-state-ink/40">({count})</span>
      </h2>
      {count === 0 ? (
        <div className="rounded-card border border-card bg-surface-card px-1.5g py-1g text-ui text-state-ink/40 shadow-card">
          {L.tkNone}
        </div>
      ) : (
        groups.map((group) => (
          <div key={group.priority} className="mb-1.5g">
            <h3 className="mb-0.5g font-mono text-ui text-state-ink/45">{group.priority}</h3>
            <div className="flex flex-col gap-1g">
              {group.tasks.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  pending={pendingId === task.id}
                  onUnblock={onUnblock}
                  onOpen={onOpen}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

export interface TasksPanelProps {
  // Restrict the panel to one lifecycle (workbench Active/History filter). Omit → both.
  lifecycle?: 'open' | 'done';
  // Restrict the panel to one project (workbench right panel scopes to the current project). Omit → all.
  projectId?: string;
}

// Reusable Tasks body (design 4a): real tasks.list via tRPC, grouped by lifecycle · priority,
// live-refresh via useTasksLiveSync, Claim/Complete mutations. Consumed by the /tasks page
// (both lifecycles) and the workbench right-panel Tasks tab (one lifecycle via `lifecycle`).
export function TasksPanel({ lifecycle, projectId }: TasksPanelProps) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const tasksQuery = useQuery(
    trpc.tasks.list.queryOptions({
      ...(lifecycle ? { status: lifecycle } : {}),
      ...(projectId ? { projectId } : {}),
    }),
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  useTasksLiveSync();

  const invalidate = () => queryClient.invalidateQueries(trpc.tasks.list.queryFilter());

  const complete = useMutation(
    trpc.tasks.complete.mutationOptions({
      onSettled: () => {
        setPendingId(null);
        setOpenTaskId(null);
        invalidate();
      },
    }),
  );
  const unblock = useMutation(
    trpc.tasks.unblock.mutationOptions({
      onSettled: () => {
        setPendingId(null);
        invalidate();
      },
    }),
  );

  const onComplete = (t: TaskInfo) => {
    setPendingId(t.id);
    complete.mutate({ projectId: t.project, taskId: t.id, note: 'completed via Web UI' });
  };
  const onUnblock = (t: TaskInfo) => {
    setPendingId(t.id);
    unblock.mutate({ projectId: t.project, taskId: t.id });
  };
  const onOpen = (t: TaskInfo) => setOpenTaskId(t.id);

  if (tasksQuery.isPending) {
    return <div className="text-ui text-state-ink/40">{L.tkLoading}</div>;
  }

  if (tasksQuery.isError) {
    return (
      <div className="rounded-card border border-card bg-pill-failed-bg px-1.5g py-1g text-ui text-pill-failed-fg shadow-card">
        {L.tkLoadFailed}: {tasksQuery.error.message}
      </div>
    );
  }

  if (tasksQuery.data.length === 0) {
    return <div className="text-ui text-state-ink/40">{L.mNoTasks}</div>;
  }

  const grouped = groupTasks(tasksQuery.data);
  const showOpen = lifecycle !== 'done';
  const showDone = lifecycle !== 'open';
  const openTask = openTaskId ? tasksQuery.data.find((t) => t.id === openTaskId) : undefined;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {showOpen && (
        <GroupSection
          title={L.open}
          groups={grouped.open}
          pendingId={pendingId}
          onUnblock={onUnblock}
          onOpen={onOpen}
        />
      )}
      {showDone && (
        <GroupSection
          title={L.tkDone}
          groups={grouped.done}
          pendingId={pendingId}
          onUnblock={onUnblock}
          onOpen={onOpen}
        />
      )}
      {openTask && (
        <TaskModal
          task={openTask}
          allTasks={tasksQuery.data}
          pending={pendingId === openTask.id}
          onClose={() => setOpenTaskId(null)}
          onComplete={onComplete}
          onUnblock={onUnblock}
        />
      )}
    </div>
  );
}
