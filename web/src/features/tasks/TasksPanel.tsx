// input:  react, feature data, theme tokens
// output: TasksPanel presentation
// pos:    Dense tasks content surface
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { useVocab } from '@/i18n';
import { groupTasks, type TaskGroupKind } from './group-tasks';
import { TaskRow } from './TaskRow';
import { useTaskModal } from './TaskModalProvider';
import { useTasksLiveSync } from './useTasksLiveSync';

const GROUP_LABEL_STYLE = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.07em',
  textTransform: 'uppercase',
  color: 'var(--proto-muted)',
  padding: '6px 6px',
} as const;

const ERROR_STYLE = {
  borderRadius: 'var(--r-control)',
  border: '1px solid var(--proto-line-2)',
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {tasks.map((task) => <TaskRow key={task.id} task={task} kind={kind} onOpen={onOpen} />)}
      </div>
    </section>
  );
}

function TaskSections({ groups, onOpen }: {
  groups: ReturnType<typeof groupTasks>;
  onOpen: (task: TaskInfo) => void;
}) {
  const vocab = useVocab();
  if (groups.length === 0) {
    return <div style={{ fontSize: 12, color: 'var(--proto-muted)', padding: '24px 0', textAlign: 'center' }}>{vocab.mNoTasks}</div>;
  }
  return <>{groups.map((group) => <GroupSection key={group.kind} {...group} onOpen={onOpen} />)}</>;
}

function TaskFooter({ tasks, groups }: { tasks: TaskInfo[]; groups: ReturnType<typeof groupTasks> }) {
  const vocab = useVocab();
  const done = groups.find((group) => group.kind === 'done')?.tasks.length ?? 0;
  return (
    <div style={{ flex: 'none', display: 'flex', alignItems: 'center', padding: '8px 2px 0', borderTop: '1px solid var(--proto-line-2)', font: "400 11px 'IBM Plex Mono',monospace", color: 'var(--proto-muted)' }}>
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
  const { openTask } = useTaskModal();
  const query = useQuery(trpc.tasks.list.queryOptions(projectId ? { projectId } : {}));
  useTasksLiveSync();
  const tasks = query.data ?? [];
  const groups = useMemo(() => groupTasks(tasks), [tasks]);

  if (query.isPending) return <div style={{ fontSize: 12, color: 'var(--proto-muted)', padding: 12 }}>{vocab.tkLoading}</div>;
  if (query.isError) return <div style={ERROR_STYLE}>{vocab.tkLoadFailed}: {query.error.message}</div>;
  return (
    <div style={{ minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <TaskSections groups={groups} onOpen={(task) => openTask(task.project, task.id)} />
      </div>
      <TaskFooter tasks={tasks} groups={groups} />
    </div>
  );
}
