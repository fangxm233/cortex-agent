// input:  UiServiceDeps, TasksListParams, task and thread records
// output: Task DTOs with lifecycle, dependencies and claim thread
// pos:    Task DTO mapper and tasks.list query handler
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { UiServiceDeps, TaskInfo, TasksListParams } from '../types.js';

const ACTIVE_THREAD_STATUSES = new Set(['running', 'waiting', 'rate_limited']);

function taskThreadKey(project: string, taskId: string): string {
  return `${project}\0${taskId}`;
}

function claimThreadMap(deps: UiServiceDeps): Map<string, string> {
  const result = new Map<string, string>();
  for (const thread of deps.threadStore.getAll()) {
    const taskId = thread.metadata?.taskId;
    const project = thread.metadata?.taskProject ?? thread.projectId;
    const key = taskId && project ? taskThreadKey(project, taskId) : null;
    if (!key || !ACTIVE_THREAD_STATUSES.has(thread.status) || result.has(key)) continue;
    result.set(key, thread.id);
  }
  return result;
}

function unresolvedDependencies(task: any, completedIds: ReadonlySet<string>): string[] {
  return (task.depends_on ?? []).filter((dependency: string) => !completedIds.has(dependency));
}

function isTaskActionable(task: any, unmetDependencyIds: string[], today: string): boolean {
  return task.status === 'open'
    && !task.paused
    && !task.claimed_by
    && !task.blocked_by
    && !(task.approval_needed && !task.approved_at)
    && unmetDependencyIds.length === 0
    && !(task.not_before && task.not_before > today);
}

function mapTaskInfo(
  task: any,
  claimThreadId: string | null,
  unmetDependencyIds?: string[],
  actionable?: boolean,
): TaskInfo {
  return {
    id: task.id,
    text: task.text,
    project: task.project,
    status: task.status === 'done' ? 'done' : 'open',
    priority: task.priority || 'medium',
    actionable: actionable ?? !!(task.status === 'open' && !task.claimed_by && !task.blocked_by && !task.paused),
    claimedBy: task.claimed_by ?? null,
    claimThreadId,
    blockedBy: task.blocked_by ?? null,
    approvalNeeded: task.approval_needed === true,
    approvedAt: task.approved_at ?? null,
    dependsOn: task.depends_on || [],
    unmetDependencyIds,
    plan: task.plan ?? null,
    template: task.template || 'coder-review',
    why: task.why || null,
    doneWhen: task.done_when || null,
    completedAt: task.completed_at ?? null,
  };
}

export function toTaskInfo(task: any): TaskInfo {
  return mapTaskInfo(task, null);
}

export async function handleTasksList(
  deps: UiServiceDeps,
  params: TasksListParams,
): Promise<TaskInfo[]> {
  deps.taskStore.refresh();
  const allTasks = deps.taskStore.getAll();
  const completedIds = new Set<string>(
    allTasks.filter((task: any) => task.status === 'done' && task.id).map((task: any) => task.id),
  );
  const today = new Date().toISOString().slice(0, 10);
  const projected = allTasks.map((task: any) => {
    const unmetDependencyIds = unresolvedDependencies(task, completedIds);
    return { task, unmetDependencyIds, actionable: isTaskActionable(task, unmetDependencyIds, today) };
  });
  const threadByTask = claimThreadMap(deps);
  return projected
    .filter(({ task }) => !params.projectId || task.project === params.projectId)
    .filter(({ task }) => !params.status || task.status === params.status)
    .filter((item) => params.actionable === undefined || item.actionable === params.actionable)
    .map(({ task, unmetDependencyIds, actionable }) => {
      const key = taskThreadKey(task.project, task.id);
      const threadId = task.claimed_by ? threadByTask.get(key) ?? null : null;
      return mapTaskInfo(task, threadId, unmetDependencyIds, actionable);
    });
}
