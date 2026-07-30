// input:  Task queries, lifecycle model, mutations, and live sync
// output: Complete lifecycle-grouped task panel and detail modal
// pos:    Desktop task list orchestration and rendering
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { groupTasks, type TaskGroupKind } from './group-tasks';
import { TaskRow } from './TaskRow';
import { TaskModal } from './TaskModal';
import { useTasksLiveSync } from './useTasksLiveSync';

const GROUP_LABEL_STYLE = {
  fontSize: 11.5,
  fontWeight: 700,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--proto-muted)',
  padding: '8px 2px 4px',
} as const;

const ERROR_STYLE = {
  borderRadius: 10,
  border: '1px solid var(--proto-line)',
  background: 'var(--proto-danger-bg)',
  padding: '6px 10px',
  fontSize: 12,
  color: 'var(--proto-danger)',
} as const;

function GroupSection({ kind, tasks, onOpen }: {
  kind: TaskGroupKind;
  tasks: TaskInfo[];
  onOpen: (task: TaskInfo) => void;
}) {
  const vocab = useVocab();
  const labels: Record<TaskGroupKind, string> = {
    'in-progress': vocab.tkInProgress,
    actionable: vocab.tkActionable,
    'approval-needed': vocab.tkApprovalNeeded,
    'waiting-deps': vocab.tkWaitingDeps,
    blocked: vocab.mBlocked,
    done: vocab.tkDone,
  };
  return (
    <section>
      <div style={GROUP_LABEL_STYLE}>{labels[kind]} · {tasks.length}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {tasks.map((task) => <TaskRow key={task.id} task={task} kind={kind} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

function useTaskMutations(setOpenTaskId: Dispatch<SetStateAction<string | null>>) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const settle = (close: boolean) => {
    setPendingId(null);
    if (close) setOpenTaskId(null);
    queryClient.invalidateQueries(trpc.tasks.list.queryFilter());
  };
  const complete = useMutation(trpc.tasks.complete.mutationOptions({ onSettled: () => settle(true) }));
  const unblock = useMutation(trpc.tasks.unblock.mutationOptions({ onSettled: () => settle(false) }));
  return {
    pendingId,
    onComplete: (task: TaskInfo) => {
      setPendingId(task.id);
      complete.mutate({ projectId: task.project, taskId: task.id, note: 'completed via Web UI' });
    },
    onUnblock: (task: TaskInfo) => {
      setPendingId(task.id);
      unblock.mutate({ projectId: task.project, taskId: task.id });
    },
  };
}

function TaskSections({ groups, onOpen }: {
  groups: ReturnType<typeof groupTasks>;
  onOpen: (task: TaskInfo) => void;
}) {
  const vocab = useVocab();
  if (groups.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', padding: '24px 0', textAlign: 'center' }}>{vocab.mNoTasks}</div>;
  }
  return <>{groups.map((group) => <GroupSection key={group.kind} {...group} onOpen={onOpen} />)}</>;
}

function TaskFooter({ tasks, groups }: { tasks: TaskInfo[]; groups: ReturnType<typeof groupTasks> }) {
  const vocab = useVocab();
  const done = groups.find((group) => group.kind === 'done')?.tasks.length ?? 0;
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', padding: '8px 2px 0', borderTop: '1px solid var(--proto-line-2)', font: "400 9.5px 'IBM Plex Mono',monospace", color: 'var(--proto-faint)' }}>
      <span>TASKS.yaml · {vocab.synced}</span>
      <span style={{ marginLeft: 'auto' }}>{tasks.length} total · {done} done</span>
    </div>
  );
}

export interface TasksPanelProps {
  projectId?: string;
}

export function TasksPanel({ projectId }: TasksPanelProps) {
  const vocab = useVocab();
  const trpc = useTRPC();
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const actions = useTaskMutations(setOpenTaskId);
  const query = useQuery(trpc.tasks.list.queryOptions(projectId ? { projectId } : {}));
  useTasksLiveSync();
  const tasks = query.data ?? [];
  const groups = useMemo(() => groupTasks(tasks), [tasks]);
  const openTask = openTaskId ? tasks.find((task) => task.id === openTaskId) : undefined;

  if (query.isPending) return <div style={{ fontSize: 12, color: 'var(--proto-muted-2)', padding: 12 }}>{vocab.tkLoading}</div>;
  if (query.isError) return <div style={ERROR_STYLE}>{vocab.tkLoadFailed}: {query.error.message}</div>;
  return (
    <div style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <TaskSections groups={groups} onOpen={(task) => setOpenTaskId(task.id)} />
      </div>
      <TaskFooter tasks={tasks} groups={groups} />
      {openTask && <TaskModal task={openTask} allTasks={tasks} pending={actions.pendingId === openTask.id} onClose={() => setOpenTaskId(null)} onComplete={actions.onComplete} onUnblock={actions.onUnblock} />}
    </div>
  );
}
