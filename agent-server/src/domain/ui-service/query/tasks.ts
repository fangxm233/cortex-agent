// input:  UiServiceDeps, TasksListParams, task records
// output: Task DTOs with lifecycle and approval state
// pos:    Task DTO mapper and tasks.list query handler
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { UiServiceDeps, TaskInfo, TasksListParams } from '../types.js';

export function toTaskInfo(t: any): TaskInfo {
  return {
    id: t.id,
    text: t.text,
    project: t.project,
    status: t.status === 'done' ? 'done' : 'open',
    priority: t.priority || 'medium',
    actionable: !!(t.status === 'open' && !t.claimed_by && !t.blocked_by && !t.paused),
    claimedBy: t.claimed_by ?? null,
    blockedBy: t.blocked_by ?? null,
    approvalNeeded: t.approval_needed === true,
    approvedAt: t.approved_at ?? null,
    dependsOn: t.depends_on || [],
    plan: t.plan ?? null,
    template: t.template || 'coder-review',
    why: t.why || null,
    doneWhen: t.done_when || null,
  };
}

export async function handleTasksList(
  deps: UiServiceDeps,
  params: TasksListParams,
): Promise<TaskInfo[]> {
  const { projectId, status, actionable } = params;

  deps.taskStore.refresh();
  let tasks = deps.taskStore.getAll(projectId || undefined);

  if (status) {
    tasks = tasks.filter((t: any) => t.status === status);
  }
  if (actionable !== undefined) {
    tasks = tasks.filter((t: any) => {
      const isActionable = t.status === 'open' && !t.claimed_by && !t.blocked_by && !t.paused;
      return actionable ? isActionable : !isActionable;
    });
  }

  return tasks.map(toTaskInfo);
}
