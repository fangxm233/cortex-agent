// input:  task tRPC queries/mutations and TaskModal
// output: AppShell-level task modal provider and open API
// pos:    Opens project-scoped desktop task details globally
// >>> If I am updated, update my header comment and CORTEX.md <<<

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { useTRPC } from '@/lib/trpc';
import { TaskModal } from './TaskModal';

export interface TaskModalRef {
  projectId: string;
  taskId: string;
}

export type TaskModalAction =
  | { type: 'open'; projectId: string; taskId: string }
  | { type: 'close' };

export function nextTaskModalRef(
  _current: TaskModalRef | null,
  action: TaskModalAction,
): TaskModalRef | null {
  return action.type === 'open'
    ? { projectId: action.projectId, taskId: action.taskId }
    : null;
}

interface TaskModalContextValue {
  openTask: (projectId: string, taskId: string) => void;
  closeTask: () => void;
}

const TaskModalContext = createContext<TaskModalContextValue | null>(null);

function useTaskModalActions(onClose: () => void) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries(trpc.tasks.list.queryFilter());
  const complete = useMutation(trpc.tasks.complete.mutationOptions({
    onSettled: () => {
      onClose();
      void invalidate();
    },
  }));
  const unblock = useMutation(trpc.tasks.unblock.mutationOptions({
    onSettled: () => void invalidate(),
  }));
  const completeTask = (task: TaskInfo) => complete.mutate({
    projectId: task.project,
    taskId: task.id,
    note: 'completed via Web UI',
  });
  const unblockTask = (task: TaskInfo) => unblock.mutate({ projectId: task.project, taskId: task.id });
  return { completeTask, unblockTask, pending: complete.isPending || unblock.isPending };
}

function TaskModalController({ selection, onClose }: {
  selection: TaskModalRef;
  onClose: () => void;
}) {
  const trpc = useTRPC();
  const tasksQuery = useQuery(trpc.tasks.list.queryOptions({ projectId: selection.projectId }));
  const actions = useTaskModalActions(onClose);
  const allTasks = tasksQuery.data ?? [];
  const task = allTasks.find((candidate) => candidate.id === selection.taskId);
  if (!task) return null;
  return <TaskModal task={task} allTasks={allTasks} pending={actions.pending} onClose={onClose}
    onComplete={actions.completeTask} onUnblock={actions.unblockTask} />;
}

export function TaskModalProvider({ children }: { children: ReactNode }) {
  const [selection, dispatch] = useReducer(nextTaskModalRef, null);
  const openTask = useCallback((projectId: string, taskId: string) => {
    dispatch({ type: 'open', projectId, taskId });
  }, []);
  const closeTask = useCallback(() => dispatch({ type: 'close' }), []);
  const value = useMemo(() => ({ openTask, closeTask }), [openTask, closeTask]);
  return (
    <TaskModalContext.Provider value={value}>
      {children}
      {selection && <TaskModalController selection={selection} onClose={closeTask} />}
    </TaskModalContext.Provider>
  );
}

export function useTaskModal(): TaskModalContextValue {
  const context = useContext(TaskModalContext);
  if (!context) throw new Error('useTaskModal must be used within a TaskModalProvider');
  return context;
}
