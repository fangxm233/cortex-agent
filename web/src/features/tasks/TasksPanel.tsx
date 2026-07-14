import { useState, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { groupTasks, actionableOpenCount, type TaskGroupKind } from './group-tasks';
import { TaskRow } from './TaskRow';
import { TaskModal } from './TaskModal';
import { useTasksLiveSync } from './useTasksLiveSync';

// Design 4a (scheme.dc.html L624-745): lifecycle groups in a fixed order with section headers
// styled as uppercase mono labels. Each group has a coloured dot + label + count. Cards show
// one-line task text (ellipsis), an ID, status metadata. No done-when display, no "+ Task" button.

const SECTION_STYLE: Record<TaskGroupKind, { dot: string }> = {
  'in-progress': { dot: '#C03D33' },
  actionable: { dot: '#C99A2E' },
  'waiting-deps': { dot: '#B6BDC9' },
  blocked: { dot: '#C99A2E' },
  done: { dot: '#23854F' },
};

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
  const styles = SECTION_STYLE[kind];

  return (
    <section>
      <div
        style={{
          fontSize: 9.5,
          fontWeight: 700,
          letterSpacing: '.07em',
          color: '#B6BDC9',
          padding: '8px 2px 2px',
        }}
      >
        <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: styles.dot, marginRight: 6 }} />
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
  const [scope, setScope] = useState<'actionable' | 'all'>('actionable');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

  const tasksQuery = useQuery(
    trpc.tasks.list.queryOptions({
      ...(projectId ? { projectId } : {}),
    }),
  );

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
    return <div style={{ fontSize: 12, color: '#8A93A2', padding: 12 }}>{L.tkLoading}</div>;
  }

  if (tasksQuery.isError) {
    return (
      <div style={{
        borderRadius: 10, border: '1px solid #E7E9EE', background: '#FBEDEB',
        padding: '6px 10px', fontSize: 12, color: '#C03D33',
      }}>
        {L.tkLoadFailed}: {tasksQuery.error.message}
      </div>
    );
  }

  const allTasks = tasksQuery.data;
  const grouped = useMemo(() => groupTasks(allTasks), [allTasks]);

  // When scope === 'actionable', hide the "done" group
  const visible = scope === 'actionable'
    ? grouped.filter((g) => g.kind !== 'done')
    : grouped;

  const actionableCount = actionableOpenCount(allTasks);
  const totalCount = allTasks.length;
  const openTask = openTaskId ? allTasks.find((t) => t.id === openTaskId) : undefined;

  return (
    <div style={{ minHeight: 0, flex: 1, overflow: 'auto' }}>
      {/* Filter row: Actionable / All toggle — no "+ Task" button per the spec */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '0 0 8px', flex: 'none' }}>
        <div style={{ display: 'flex', background: '#EFF1F5', borderRadius: 7, padding: 2 }}>
          <span
            onClick={() => setScope('actionable')}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: scope === 'actionable' ? '#191C22' : '#8A93A2',
              background: scope === 'actionable' ? '#fff' : 'transparent',
              borderRadius: 5,
              padding: '3px 10px',
              cursor: 'pointer',
              boxShadow: scope === 'actionable' ? '0 1px 2px rgba(16,24,40,.06)' : 'none',
            }}
          >
            {L.tkActionable} {actionableCount}
          </span>
          <span
            onClick={() => setScope('all')}
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: scope === 'all' ? '#191C22' : '#8A93A2',
              background: scope === 'all' ? '#fff' : 'transparent',
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
        <div style={{ fontSize: 12, color: '#8A93A2', padding: '24px 0', textAlign: 'center' }}>
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

      {/* Footer */}
      <div
        style={{
          marginTop: 'auto',
          display: 'flex',
          alignItems: 'center',
          padding: '8px 2px 0',
          borderTop: '1px solid #EFF1F5',
          font: "400 9.5px 'IBM Plex Mono',monospace",
          color: '#B6BDC9',
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
