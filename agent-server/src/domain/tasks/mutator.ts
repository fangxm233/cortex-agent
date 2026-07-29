// input:  task repo, lifecycle and project-lock operations
// output: task mutations and terminal events
// pos:    Serializes task mutations across processes
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { taskStore, TaskRepo } from '@store/task-repo.js';
import type { EventBus } from '@events/index.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import {
  approveTask as lifecycleApproveTask,
  blockTask as lifecycleBlockTask,
  claimTask as lifecycleClaimTask,
  clearApprovalTask as lifecycleClearApprovalTask,
  pauseTask as lifecyclePauseTask,
  requestApprovalTask as lifecycleRequestApprovalTask,
  resumeTask as lifecycleResumeTask,
  unblockTask as lifecycleUnblockTask,
  unclaimTask as lifecycleUnclaimTask,
} from './system/task-state.js';
import {
  completeTask as lifecycleCompleteTask,
  uncompleteTask as lifecycleUncompleteTask,
} from './system/task-completion.js';
import {
  addTask as lifecycleAddTask,
  batchEdit as lifecycleBatchEdit,
  decomposeTask as lifecycleDecomposeTask,
} from './system/task-mutations.js';
import { editTask as lifecycleEditTask } from './system/task-lifecycle-edit.js';
import {
  acquireLock,
  assertLockHeld,
  getOwnerIdentity,
  isProjectLocked,
  releaseLock,
} from './system/task-lock.js';

interface AddTaskOptions {
  plan?: string;
  system?: boolean;
}

interface AddTaskRequest {
  project: string;
  text: string;
  why: string;
  doneWhen: string;
  priority: string;
  template: string | null;
  dependsOn: string[] | null;
  plan: string | null;
}

const SYSTEM_LOCK_RETRY_MS = 50;
let systemLockSequence = 0;

function addTaskRecord(request: AddTaskRequest): any {
  return lifecycleAddTask(
    request.project, request.text, request.why, request.doneWhen,
    request.priority, request.template, request.dependsOn, request.plan,
  );
}

async function acquireSystemProjectLock(project: string): Promise<string> {
  const owner = `system:${process.pid}:${++systemLockSequence}`;
  while (!acquireLock(project, { owner }).acquired) {
    await new Promise((resolve) => setTimeout(resolve, SYSTEM_LOCK_RETRY_MS));
  }
  return owner;
}

function releaseSystemProjectLock(project: string, owner: string): void {
  const result = releaseLock(project, owner);
  if (!result.released) throw new Error(result.message || `Failed to release project lock for ${project}`);
}

export class TaskMutator {
  constructor(
    private store: TaskRepo = taskStore,
    private bus?: EventBus,
  ) {}

  setBus(bus: EventBus): void {
    this.bus = bus;
  }

  /** getById with a one-shot refresh on miss: tasks created out-of-process (CLI, manager
   *  threads) reach the in-memory cache only on refresh — callers like the cortex-run
   *  callback may fire before any dispatch cycle has reloaded TASKS.yaml. */
  private getByIdFresh(taskId: string): any | null {
    let task = this.store.getById(taskId);
    if (!task) {
      this.store.refresh();
      task = this.store.getById(taskId);
    }
    return task;
  }

  async claim(taskId: string, agent: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleClaimTask(task.text, task.project, agent, taskId);
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: claim ${taskId} by ${agent}`);
        this.bus?.publish({ type: 'task.claimed', taskId, by: agent });
      }
      return result;
    });
  }

  async unclaim(taskId: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleUnclaimTask(task.text, task.project, taskId);
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: unclaim ${taskId}`);
        this.bus?.publish({ type: 'task.unclaimed', taskId });
      }
      return result;
    });
  }

  async complete(taskId: string, note?: string, options: { skipVerify?: boolean; skipVerifyReason?: string } = {}): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.getByIdFresh(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleCompleteTask(task.text, task.project, note || '', taskId,
        options.skipVerify ?? false, options.skipVerifyReason ?? null);
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: complete ${taskId}`);
        this.bus?.publish({ type: 'task.completed', taskId });
        void emitCortexEvent('cortex:task.completed', { taskId, project: task.project }).catch(() => {});
      }
      return result;
    });
  }

  async uncomplete(taskId: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleUncompleteTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: uncomplete ${taskId}`); }
      return result;
    });
  }

  async block(taskId: string, reason: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.getByIdFresh(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleBlockTask(task.text, task.project, reason, taskId);
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: block ${taskId}`);
        // DR-0014 §8: a blocked task is a child's escalation — wake its waiting manager.
        this.bus?.publish({ type: 'task.blocked', taskId, reason });
        void emitCortexEvent('cortex:task.blocked', { taskId, project: task.project, reason }).catch(() => {});
      }
      return result;
    });
  }

  async unblock(taskId: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleUnblockTask(task.text, task.project, taskId);
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: unblock ${taskId}`);
        this.bus?.publish({ type: 'task.unblocked', taskId });
      }
      return result;
    });
  }

  async pause(taskId: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecyclePauseTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: pause ${taskId}`); }
      return result;
    });
  }

  async resume(taskId: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleResumeTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: resume ${taskId}`); }
      return result;
    });
  }

  async requestApproval(taskId: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleRequestApprovalTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: requestApproval ${taskId}`); }
      return result;
    });
  }

  async approve(taskId: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleApproveTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: approve ${taskId}`); }
      return result;
    });
  }

  async clearApproval(taskId: string): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleClearApprovalTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: clearApproval ${taskId}`); }
      return result;
    });
  }

  async batchEdit(project: string, taskIds: string[], options: any): Promise<any> {
    return this.store.runExclusive(() => {
      const lockError = assertLockHeld(project, getOwnerIdentity());
      if (lockError) return { success: false, message: lockError };
      const result = lifecycleBatchEdit(project, taskIds, options);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: batch-edit ${taskIds.length} tasks in ${project}`); }
      return result;
    });
  }

  async add(
    project: string,
    text: string,
    why: string,
    doneWhen: string,
    priority?: string,
    template?: string,
    dependsOn?: string[],
    options: AddTaskOptions = {},
  ): Promise<any> {
    const request: AddTaskRequest = {
      project, text, why, doneWhen,
      priority: priority || 'medium',
      template: template || null,
      dependsOn: dependsOn || null,
      plan: options.plan || null,
    };
    if (options.system) return this.addSystemTask(request);
    return this.store.runExclusive(() => {
      const lockError = assertLockHeld(project, getOwnerIdentity());
      if (lockError) return { success: false, message: lockError };
      const result = addTaskRecord(request);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: add task to ${project}`); }
      return result;
    });
  }

  private async addSystemTask(request: AddTaskRequest): Promise<any> {
    const owner = await acquireSystemProjectLock(request.project);
    return this.store.runExclusive(() => {
      let result: any;
      try {
        result = addTaskRecord(request);
      } finally {
        releaseSystemProjectLock(request.project, owner);
      }
      if (result.success) {
        this.store.refresh();
        this.store.commitAndPush(`task-store: add task to ${request.project}`);
      }
      return result;
    });
  }

  async edit(project: string, options: any): Promise<any> {
    return this.store.runExclusive(() => {
      const lockError = assertLockHeld(project, getOwnerIdentity());
      if (lockError) return { success: false, message: lockError };
      const result = lifecycleEditTask(project, options);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: edit task in ${project}`); }
      return result;
    });
  }

  async decompose(
    project: string,
    taskText: string | null,
    subtasks: any[],
    taskId?: string | null,
    options: { keepParent?: boolean; system?: boolean } = {},
  ): Promise<any> {
    return this.store.runExclusive(() => {
      if (options.system) {
        // System-initiated decompose ([SPLIT] dispatch path, DR-0014): no agent holds the
        // lock here — proceed unless a FOREIGN lock exists (defer to the lock holder).
        const l = isProjectLocked(project);
        if (l.locked) return { success: false, message: `Project lock held by ${l.owner} — split deferred` };
      } else {
        const lockError = assertLockHeld(project, getOwnerIdentity());
        if (lockError) return { success: false, message: lockError };
      }
      const result = lifecycleDecomposeTask(project, taskText, subtasks, taskId || null, { keepParent: options.keepParent });
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: decompose task in ${project}${options.keepParent ? ' (keep-parent)' : ''}`); }
      return result;
    });
  }
}

export const taskMutator = new TaskMutator();
