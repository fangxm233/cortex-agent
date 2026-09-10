// input:  task repo, lifecycle ownership, locks, EventBus
// output: serialized mutations, generation-aware events
// pos:    Serializes task mutations across processes
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { taskStore, TaskRepo } from '@store/task-repo.js';
import type { TaskGenerationExpectation } from '@core/task-parser.js';
import type { EventBus } from '@events/index.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import {
  approveTaskAsync as lifecycleApproveTask,
  blockTaskAsync as lifecycleBlockTask,
  claimTaskAsync as lifecycleClaimTask,
  clearApprovalTaskAsync as lifecycleClearApprovalTask,
  pauseTaskAsync as lifecyclePauseTask,
  requestApprovalTaskAsync as lifecycleRequestApprovalTask,
  resumeTaskAsync as lifecycleResumeTask,
  unblockTaskAsync as lifecycleUnblockTask,
  unclaimTaskAsync as lifecycleUnclaimTask,
} from './system/task-state.js';
import {
  completeTaskAsync as lifecycleCompleteTask,
  uncompleteTaskAsync as lifecycleUncompleteTask,
} from './system/task-completion.js';
import {
  addTaskAsync as lifecycleAddTask,
  batchEditAsync as lifecycleBatchEdit,
  decomposeTaskAsync as lifecycleDecomposeTask,
} from './system/task-mutations.js';
import { editTaskAsync as lifecycleEditTask } from './system/task-lifecycle-edit.js';
import {
  acquireLockAsync,
  assertLockHeld,
  getOwnerIdentity,
  isProjectLocked,
  releaseLockAsync,
} from './system/task-lock.js';

interface ClaimTaskOptions {
  generation?: string | null;
}

interface OwnedMutationOptions {
  ownership?: TaskGenerationExpectation;
}

interface CompleteTaskOptions extends OwnedMutationOptions {
  skipVerify?: boolean;
  skipVerifyReason?: string;
  ownership?: TaskGenerationExpectation;
}

interface AddTaskOptions {
  plan?: string;
  system?: boolean;
}

interface DecomposeTaskOptions extends OwnedMutationOptions {
  keepParent?: boolean;
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

async function addTaskRecord(request: AddTaskRequest): Promise<any> {
  return await lifecycleAddTask(
    request.project, request.text, request.why, request.doneWhen,
    request.priority, request.template, request.dependsOn, request.plan,
  );
}

async function acquireSystemProjectLock(project: string): Promise<string> {
  const owner = `system:${process.pid}:${++systemLockSequence}`;
  // Async lock: a contended cross-process mutation lock must not park the event loop here.
  while (!(await acquireLockAsync(project, { owner })).acquired) {
    await new Promise((resolve) => setTimeout(resolve, SYSTEM_LOCK_RETRY_MS));
  }
  return owner;
}

async function releaseSystemProjectLock(project: string, owner: string): Promise<void> {
  const result = await releaseLockAsync(project, owner);
  if (!result.released) throw new Error(result.message || `Failed to release project lock for ${project}`);
}

function decomposeLockError(project: string, options: DecomposeTaskOptions): string | null {
  if (!options.system) return assertLockHeld(project, getOwnerIdentity());
  const lock = isProjectLocked(project);
  return lock.locked ? `Project lock held by ${lock.owner} — split deferred` : null;
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

  async claim(taskId: string, agent: string, options: ClaimTaskOptions = {}): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleClaimTask(
        task.text, task.project, agent, taskId, options.generation ?? null,
      );
      if (result.success) {
        this.store.refresh(); await this.store.commitAndPush(`task-store: claim ${taskId} by ${agent}`);
        this.bus?.publish({ type: 'task.claimed', taskId, by: agent });
      }
      return result;
    });
  }

  async unclaim(taskId: string, options: OwnedMutationOptions = {}): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleUnclaimTask(
        task.text, task.project, taskId, options.ownership,
      );
      if (result.success) {
        this.store.refresh(); await this.store.commitAndPush(`task-store: unclaim ${taskId}`);
        this.bus?.publish({ type: 'task.unclaimed', taskId });
      }
      return result;
    });
  }

  async complete(taskId: string, note?: string, options: CompleteTaskOptions = {}): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.getByIdFresh(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleCompleteTask(
        task.text, task.project, note || '', taskId,
        options.skipVerify ?? false, options.skipVerifyReason ?? null, options.ownership,
      );
      if (result.success) {
        this.store.refresh(); await this.store.commitAndPush(`task-store: complete ${taskId}`);
        this.bus?.publish({
          type: 'task.completed', taskId,
          ...(options.ownership ? { dispatchGeneration: options.ownership.generation } : {}),
        });
        void emitCortexEvent('cortex:task.completed', { taskId, project: task.project }).catch(() => {});
      }
      return result;
    });
  }

  async uncomplete(taskId: string): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleUncompleteTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: uncomplete ${taskId}`); }
      return result;
    });
  }

  async block(taskId: string, reason: string, options: OwnedMutationOptions = {}): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.getByIdFresh(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleBlockTask(
        task.text, task.project, reason, taskId, options.ownership,
      );
      if (result.success) {
        this.store.refresh(); await this.store.commitAndPush(`task-store: block ${taskId}`);
        // DR-0014 §8: a blocked task is a child's escalation — wake its waiting manager.
        this.bus?.publish({
          type: 'task.blocked', taskId, reason,
          ...(options.ownership ? { dispatchGeneration: options.ownership.generation } : {}),
        });
        void emitCortexEvent('cortex:task.blocked', { taskId, project: task.project, reason }).catch(() => {});
      }
      return result;
    });
  }

  async unblock(taskId: string): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleUnblockTask(task.text, task.project, taskId);
      if (result.success) {
        this.store.refresh(); await this.store.commitAndPush(`task-store: unblock ${taskId}`);
        this.bus?.publish({ type: 'task.unblocked', taskId });
      }
      return result;
    });
  }

  async pause(taskId: string): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecyclePauseTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: pause ${taskId}`); }
      return result;
    });
  }

  async resume(taskId: string): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleResumeTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: resume ${taskId}`); }
      return result;
    });
  }

  async requestApproval(taskId: string): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleRequestApprovalTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: requestApproval ${taskId}`); }
      return result;
    });
  }

  async approve(taskId: string): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleApproveTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: approve ${taskId}`); }
      return result;
    });
  }

  async clearApproval(taskId: string): Promise<any> {
    return this.store.runExclusive(async () => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = await lifecycleClearApprovalTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: clearApproval ${taskId}`); }
      return result;
    });
  }

  async batchEdit(project: string, taskIds: string[], options: any): Promise<any> {
    return this.store.runExclusive(async () => {
      const lockError = assertLockHeld(project, getOwnerIdentity());
      if (lockError) return { success: false, message: lockError };
      const result = await lifecycleBatchEdit(project, taskIds, options);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: batch-edit ${taskIds.length} tasks in ${project}`); }
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
    return this.store.runExclusive(async () => {
      const lockError = assertLockHeld(project, getOwnerIdentity());
      if (lockError) return { success: false, message: lockError };
      const result = await addTaskRecord(request);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: add task to ${project}`); }
      return result;
    });
  }

  private async addSystemTask(request: AddTaskRequest): Promise<any> {
    const owner = await acquireSystemProjectLock(request.project);
    return this.store.runExclusive(async () => {
      let result: any;
      try {
        result = await addTaskRecord(request);
      } finally {
        await releaseSystemProjectLock(request.project, owner);
      }
      if (result.success) {
        this.store.refresh();
        await this.store.commitAndPush(`task-store: add task to ${request.project}`);
      }
      return result;
    });
  }

  async edit(project: string, options: any): Promise<any> {
    return this.store.runExclusive(async () => {
      const lockError = assertLockHeld(project, getOwnerIdentity());
      if (lockError) return { success: false, message: lockError };
      const result = await lifecycleEditTask(project, options);
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: edit task in ${project}`); }
      return result;
    });
  }

  async decompose(
    project: string,
    taskText: string | null,
    subtasks: any[],
    taskId?: string | null,
    options: DecomposeTaskOptions = {},
  ): Promise<any> {
    return this.store.runExclusive(async () => {
      const lockError = decomposeLockError(project, options);
      if (lockError) return { success: false, message: lockError };
      const result = await lifecycleDecomposeTask(project, taskText, subtasks, taskId || null, {
        keepParent: options.keepParent,
        ownership: options.ownership,
      });
      if (result.success) { this.store.refresh(); await this.store.commitAndPush(`task-store: decompose task in ${project}${options.keepParent ? ' (keep-parent)' : ''}`); }
      return result;
    });
  }
}

export const taskMutator = new TaskMutator();
