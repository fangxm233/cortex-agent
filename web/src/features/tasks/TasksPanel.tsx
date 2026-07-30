// input:  task queries, lifecycle and recent completion models
// output: Task panel with Open/Recent/All scope and detail modal
// pos:    Desktop task list orchestration and rendering
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { groupTasks, actionableOpenCount, recentCompletedTasks, type TaskGroupKind } from './group-tasks';
import { TaskRow } from './TaskRow';
import { TaskModal } from './TaskModal';
import { useRecentNow } from '@/features/workbench/useRecentNow';
import { useTasksLiveSync } from './useTasksLiveSync';

// Design 4a (scheme.dc.html L624-745): lifecycle groups in a fixed order with section headers.
// Cards show one-line task text (ellipsis), an ID, status metadata.
// No done-when display, no "+ Task" button. Footer is fixed at the bottom.

function GroupSection({
  kind,
  tasks,
  onOpen,
}: {
  kind: TaskGroupKind;
  tasks: TaskInfo[];
  onOpen: (t: TaskInfo) => void;
}) {
  const L = useVocab();
  const i18nLabels: Record<TaskGroupKind, string> = {
    'in-progress': L.tkInProgress,
    actionable: L.tkActionable,
    'waiting-deps': L.tkWaitingDeps,
    blocked: L.mBlocked,
    done: L.tkDone,
  };
  const label = i18nLabels[kind];

  return (
    <section>
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 700,
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--proto-muted)',
          padding: '8px 2px 4px',
        }}
      >
        {label} · {tasks.length}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {tasks.map((task) => (
          <TaskRow key={task.id} task={task} onOpen={onOpen} />
        ))}
      </div>
    </section>
  );
}

export interface TasksPanelProps {
  // Restrict the panel to one project (workbench right panel scopes to the current project). Omit → all.
  projectId?: string;
}

// Reusable Tasks body (design 4a): real tasks.list via tRPC, grouped by lifecycle,
// live-refresh via useTasksLiveSync, Claim/Complete mutations.
export function TasksPanel({ projectId }: TasksPanelProps) {
  const L = useVocab();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const now = useRecentNow(true);
  const [scope, setScope] = useState<'open' | 'recent' | 'all'>('open');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const tasksQuery = useQuery(
    trpc.tasks.list.queryOptions({
      ...(projectId ? { projectId } : {}),
    }),
  );

  useTasksLiveSync();

  // Call ALL hooks before any early return (React rule: hooks must be in same order every render)
  const allTasks = tasksQuery.data ?? [];
  const grouped = useMemo(() => groupTasks(allTasks), [allTasks]);
  const recentTasks = useMemo(() => recentCompletedTasks(allTasks, now), [allTasks, now]);
  const recentGrouped = useMemo(() => groupTasks(recentTasks), [recentTasks]);
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
    return <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', padding: 12 }}>{L.tkLoading}</div>;
  }

  if (tasksQuery.isError) {
    return (
      <div style={{
        borderRadius: 10, border: '1px solid var(--proto-line)', background: 'var(--proto-danger-bg)',
        padding: '6px 10px', fontSize: 12, color: 'var(--proto-danger)',
      }}>
        {L.tkLoadFailed}: {tasksQuery.error.message}
      </div>
    );
  }

  const visible = scope === 'open'
    ? grouped.filter((group) => group.kind !== 'done')
    : scope === 'recent' ? recentGrouped : grouped;

  const openCount = actionableOpenCount(allTasks);
  const totalCount = allTasks.length;
  const openTask = openTaskId ? allTasks.find((t) => t.id === openTaskId) : undefined;

  return (
    <div style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Filter row + task groups — scrollable */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
      {/* Filter row: Open / All toggle — no "+ Task" button per the spec */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 0 8px', flex: 'none' }}>
        <div style={{ display: 'flex', background: 'var(--proto-line-2)', borderRadius: 7, padding: 2 }}>
          <span
            onClick={() => setScope('open')}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: scope === 'open' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
              background: scope === 'open' ? 'var(--proto-card)' : 'transparent',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              boxShadow: scope === 'open' ? '0 1px 2px rgba(16,24,40,.06)' : 'none',
            }}
          >
            {L.tkOpen} {openCount}
          </span>
          <span
            onClick={() => setScope('recent')}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: scope === 'recent' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
              background: scope === 'recent' ? 'var(--proto-card)' : 'transparent',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              boxShadow: scope === 'recent' ? '0 1px 2px rgba(16,24,40,.06)' : 'none',
            }}
          >
            {L.recentDay} {recentTasks.length}
          </span>
          <span
            onClick={() => setScope('all')}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: scope === 'all' ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
              background: scope === 'all' ? 'var(--proto-card)' : 'transparent',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              boxShadow: scope === 'all' ? '0 1px 2px rgba(16,24,40,.06)' : 'none',
            }}
          >
            {L.tkAll} {totalCount}
          </span>
        </div>
      </div>

        {/* Task cards by lifecycle group */}
        {visible.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', padding: '24px 0', textAlign: 'center' }}>
            {L.mNoTasks}
          </div>
        ) : (
          visible.map((group) => (
            <GroupSection
              key={group.kind}
              kind={group.kind}
              tasks={group.tasks}
              onOpen={onOpen}
            />
          ))
        )}
      </div>

      {/* Footer — fixed at bottom */}
      <div
        style={{
          flex: 'none',
          display: 'flex',
          alignItems: 'center',
          padding: '8px 2px 0',
          borderTop: '1px solid var(--proto-line-2)',
          font: "400 9.5px 'IBM Plex Mono',monospace",
          color: 'var(--proto-faint)',
        }}
      >
        <span>TASKS.yaml · {L.synced}</span>
        <span style={{ marginLeft: 'auto' }}>{totalCount} total · done {grouped.find((g) => g.kind === 'done')?.tasks.length ?? 0} this week</span>
      </div>

      {openTask && (
        <TaskModal
          task={openTask}
          allTasks={allTasks}
          pending={pendingId === openTask.id}
          onClose={() => setOpenTaskId(null)}
          onComplete={onComplete}
          onUnblock={onUnblock}
        />
      )}
    </div>
  );
}
