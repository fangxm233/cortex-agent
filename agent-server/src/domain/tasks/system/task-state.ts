// input:  task lifecycle storage, task generation, current date
// output: claim, ownership-revocation, blocking, and approval transitions
// pos:    Applies non-completion TASKS.yaml state changes
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { todayISO } from '@core/utils.js';
import type { Task, TaskGenerationExpectation } from '@core/task-parser.js';
import {
  findTask, getTasksPath, readTasks, withTaskFileMutationLock, writeTasks,
} from './task-lifecycle-edit.js';
import * as fs from 'node:fs';

function claimTaskUnlocked(
  taskText: string | null, project: string, agentId: string,
  taskId: string | null = null, dispatchGeneration: string | null = null,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;

  if (task.claimed_by) return { success: false, message: 'Task already claimed (409 conflict)' };
  if (task.status === 'done') return { success: false, message: 'Task already completed' };
  if (task.blocked_by) return { success: false, message: 'Task is blocked' };

  const today = todayISO();
  task.claimed_by = agentId;
  task.claimed_at = today;
  task.dispatch_generation = dispatchGeneration;
  writeTasks(project, tasks);
  return {
    success: true, message: `Task claimed by ${agentId} on ${today}`,
    task_id: task.id, agent: agentId, claimed_at: today,
    dispatch_generation: dispatchGeneration,
  };
}

function staleOwnership(task: Task, ownership?: TaskGenerationExpectation) {
  if (!ownership || task.dispatch_generation === ownership.generation) return null;
  return {
    success: false as const,
    message: 'Stale task dispatch generation; mutation ignored',
    stale: true,
  };
}

function unclaimTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;
  if (!task.claimed_by) return { success: false, message: 'Task is not in-progress' };

  task.claimed_by = null;
  task.claimed_at = null;
  task.dispatch_generation = null;
  writeTasks(project, tasks);
  return { success: true, message: 'Task unclaimed', task_id: task.id };
}

function pauseTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  if (task.paused) return { success: false, message: 'Task is already paused' };

  task.claimed_by = null;
  task.claimed_at = null;
  task.dispatch_generation = null;
  task.paused = true;
  writeTasks(project, tasks);
  return { success: true, message: 'Task paused' };
}

function resumeTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  if (!task.paused) return { success: false, message: 'Task is not paused' };

  task.paused = false;
  writeTasks(project, tasks);
  return { success: true, message: 'Task resumed' };
}

function requestApprovalTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  if (task.approval_needed) return { success: false, message: 'Task already requires approval' };

  task.approved_at = null;
  task.approval_needed = true;
  writeTasks(project, tasks);
  return { success: true, message: 'Task marked as approval-needed' };
}

function approveTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  if (task.status === 'done') return { success: false, message: 'Cannot approve a completed task' };
  if (task.blocked_by) return { success: false, message: 'Cannot approve a blocked task — unblock it first' };

  const today = todayISO();
  task.approval_needed = false;
  task.approved_at = today;
  writeTasks(project, tasks);
  return { success: true, message: `Task approved on ${today}` };
}

function clearApprovalTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  if (!task.approval_needed && !task.approved_at) {
    return { success: false, message: 'Task has no approval tags' };
  }

  task.approval_needed = false;
  task.approved_at = null;
  writeTasks(project, tasks);
  return { success: true, message: 'Approval tags cleared' };
}

function blockTaskUnlocked(
  taskText: string | null, project: string, reason: string,
  taskId: string | null = null, ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  task.claimed_by = null;
  task.claimed_at = null;
  task.dispatch_generation = ownership?.generation ?? null;
  task.pending_at = null;
  task.blocked_by = reason;
  // Normalize a 'pending' (mid cortex-run) task back to 'open'. `status === 'pending'`
  // is an independent dispatch-exclusion gate (task-parser isActionable), so leaving it
  // here would make the task invisible to the dispatcher even after it is unblocked.
  // blocked_by still gates dispatch, so this is safe. Never resurrect a done task.
  if (task.status !== 'done') task.status = 'open';
  writeTasks(project, tasks);
  return { success: true, message: `Task blocked: ${reason}`, task_id: task.id };
}

function pendingTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  if (task.status === 'pending') return { success: true, message: 'Task is already pending (idempotent)', task_id: task.id };
  if (task.status === 'done') return { success: false, message: 'Cannot mark a completed task as pending' };

  const today = todayISO();
  task.status = 'pending';
  task.claimed_by = null;
  task.claimed_at = null;
  task.blocked_by = null;
  task.pending_at = today;
  writeTasks(project, tasks);
  return { success: true, message: `Task marked pending on ${today}`, task_id: task.id };
}

function unblockTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  task.blocked_by = null;
  task.dispatch_generation = null;
  // Defensively restore legacy stuck tasks (status=pending + blocked_by, produced before
  // blockTask normalized status) so they become dispatchable again on unblock.
  if (task.status === 'pending') {
    task.status = 'open';
    task.pending_at = null;
  }
  writeTasks(project, tasks);
  return { success: true, message: 'Task unblocked', task_id: task.id };
}

function reopenTaskUnlocked(
  taskText: string | null, project: string, taskId: string | null = null,
  ownership?: TaskGenerationExpectation,
) {
  const tasks = readTasks(project);
  if (tasks.length === 0 && !fs.existsSync(getTasksPath(project))) {
    return { success: false, message: `TASKS.yaml not found for project ${project}` };
  }
  const found = findTask(tasks, taskText, taskId);
  if ('error' in found) return { success: false, message: found.error };
  const task = found.task;
  const stale = staleOwnership(task, ownership);
  if (stale) return stale;

  if (task.status === 'done') return { success: false, message: 'Cannot reopen a completed task — use uncomplete' };
  if (task.status !== 'pending') return { success: true, message: 'Task is already open (idempotent)', task_id: task.id };

  task.status = 'open';
  task.pending_at = null;
  task.dispatch_generation = null;
  writeTasks(project, tasks);
  return { success: true, message: 'Task reopened', task_id: task.id };
}

function lockTaskMutation<T extends (...args: any[]) => any>(mutation: T): T {
  return ((...args: Parameters<T>) => withTaskFileMutationLock(
    args[1], () => mutation(...args),
  )) as T;
}

const claimTask = lockTaskMutation(claimTaskUnlocked);
const unclaimTask = lockTaskMutation(unclaimTaskUnlocked);
const pauseTask = lockTaskMutation(pauseTaskUnlocked);
const resumeTask = lockTaskMutation(resumeTaskUnlocked);
const requestApprovalTask = lockTaskMutation(requestApprovalTaskUnlocked);
const approveTask = lockTaskMutation(approveTaskUnlocked);
const clearApprovalTask = lockTaskMutation(clearApprovalTaskUnlocked);
const blockTask = lockTaskMutation(blockTaskUnlocked);
const pendingTask = lockTaskMutation(pendingTaskUnlocked);
const unblockTask = lockTaskMutation(unblockTaskUnlocked);
const reopenTask = lockTaskMutation(reopenTaskUnlocked);

export {
  approveTask,
  blockTask,
  claimTask,
  clearApprovalTask,
  pauseTask,
  pendingTask,
  reopenTask,
  requestApprovalTask,
  resumeTask,
  unblockTask,
  unclaimTask,
};
