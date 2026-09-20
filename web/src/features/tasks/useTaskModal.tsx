import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { defineModal } from '@/design/modal-registry';
import { useTRPC } from '@/lib/trpc';
import { TaskModal } from './TaskModal';

export interface TaskModalRef {
  projectId: string;
  taskId: string;
}

const taskModal = defineModal<TaskModalRef>('task-detail');

interface TaskModalContextValue {
  openTask: (projectId: string, taskId: string) => void;
  closeTask: () => void;
}

export function useTaskModal(): TaskModalContextValue {
  const { open, close } = taskModal.useModalActions();
  return useMemo(() => ({
    openTask: (projectId: string, taskId: string) => open({ projectId, taskId }),
    closeTask: close,
  }), [open, close]);
}

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

export function TaskModalHost(): JSX.Element | null {
  const { payload, close } = taskModal.useModal();
  if (!payload) return null;
  return <TaskModalController selection={payload} onClose={close} />;
}
