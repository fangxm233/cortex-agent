// input:  task repo, lifecycle ownership, locks, EventBus
// output: serialized mutations, generation-aware events
// pos:    Serializes task mutations across processes
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { taskStore, TaskRepo } from '@store/task-repo.js';
import type { TaskGenerationExpectation } from '@core/task-parser.js';
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
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleClaimTask(
        task.text, task.project, agent, taskId, options.generation ?? null,
      );
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: claim ${taskId} by ${agent}`);
        this.bus?.publish({ type: 'task.claimed', taskId, by: agent });
      }
      return result;
    });
  }

  async unclaim(taskId: string, options: OwnedMutationOptions = {}): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleUnclaimTask(
        task.text, task.project, taskId, options.ownership,
      );
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: unclaim ${taskId}`);
        this.bus?.publish({ type: 'task.unclaimed', taskId });
      }
      return result;
    });
  }

  async complete(taskId: string, note?: string, options: CompleteTaskOptions = {}): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.getByIdFresh(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleCompleteTask(
        task.text, task.project, note || '', taskId,
        options.skipVerify ?? false, options.skipVerifyReason ?? null, options.ownership,
      );
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: complete ${taskId}`);
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
    return this.store.runExclusive(() => {
      const task = this.store.getById(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleUncompleteTask(task.text, task.project, taskId);
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: uncomplete ${taskId}`); }
      return result;
    });
  }

  async block(taskId: string, reason: string, options: OwnedMutationOptions = {}): Promise<any> {
    return this.store.runExclusive(() => {
      const task = this.getByIdFresh(taskId);
      if (!task) return { success: false, message: `Task not found: ${taskId}` };
      const result = lifecycleBlockTask(
        task.text, task.project, reason, taskId, options.ownership,
      );
      if (result.success) {
        this.store.refresh(); this.store.commitAndPush(`task-store: block ${taskId}`);
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
    options: DecomposeTaskOptions = {},
  ): Promise<any> {
    return this.store.runExclusive(() => {
      const lockError = decomposeLockError(project, options);
      if (lockError) return { success: false, message: lockError };
      const result = lifecycleDecomposeTask(project, taskText, subtasks, taskId || null, {
        keepParent: options.keepParent,
        ownership: options.ownership,
      });
      if (result.success) { this.store.refresh(); this.store.commitAndPush(`task-store: decompose task in ${project}${options.keepParent ? ' (keep-parent)' : ''}`); }
      return result;
    });
  }
}

export const taskMutator = new TaskMutator();

// ── §19.12.7 the trial capability-aware mutator factory (additive, shipped → benchmark) ────────
// The import direction is shipped → benchmark: this module imports the structural P3 factory
// (`benchmark/trial-task-mutator.ts`), never the reverse, so the standalone composition never
// needs to construct this host mutator or its commit-and-push dependency. The factory
// binds the SAME shipped lifecycle functions this class already imports (claimTask, unclaimTask,
// decomposeTask, editTask) plus the P2 read/refresh surface, the P4 lock port, the exact
// registry, the shipped proposal store entry and the coordinator's release authority, and returns
// the frozen §7.2 `CapabilityAwareTaskMutator` a coordinator binds into `CompositeRuntimePorts`.
// The daemon wrapper above (class, singleton, all method bodies and all sixteen commitAndPush
// sites) is byte-unchanged.

import type { CapabilityAwareTaskMutator, TrialTaskLocks, TrialTaskRepository } from '../benchmark/composite-runtime-ports.js';
import type { ActorCapabilityRegistry } from '../benchmark/actor-capability-scope.js';
import {
  createCapabilityAwareTaskMutator, type AttemptReleaseAuthority,
} from '../benchmark/trial-task-mutator.js';
import type { ProposalInput, ProposalRow } from '../benchmark/proposal-seal.js';

/** The EXHAUSTIVE production input of `createTrialCapabilityAwareTaskMutator`. Gate 6's bootstrap
 *  supplies these real objects (§19.12.7); the factory adapts them to the structural P3 deps. */
export interface TrialCapabilityAwareTaskMutatorInput {
  /** §7.2 P2 — the authoritative trial task rows. */
  readonly repository: Pick<TrialTaskRepository, 'getById' | 'getActionable' | 'refresh'>;
  /** §7.2 P4 — the trial-owned lock port. */
  readonly locks: TrialTaskLocks;
  /** §8.2 — the exact actor capability registry (S-B). */
  readonly registry: ActorCapabilityRegistry;
  readonly trialId: string;
  /** The trial project as the lifecycle functions and the proposal store see it. */
  readonly project: string;
  /** The owner the trial lock is held under (the broker asserts the same owner). */
  readonly lockOwner: string;
  /** Gate 4's shipped proposal store entry (`proposal-seal.ts`). */
  readonly recordProposal: (project: string, input: ProposalInput) => ProposalRow;
  /** The coordinator attempt-finalisation/recovery release authority (Gate 6 supplies it). */
  readonly attemptReleaseAuthority: AttemptReleaseAuthority;
}

/** §19.12.7 — the production P3 factory. Tests and Gate 6 drive exactly this factory (plus
 *  `createDispatcherOwnedClaimTarget` and `createBenchmarkTaskBroker`) with real P2/P4/registry/
 *  proposal-store objects; there is no alternate test constructor. */
export function createTrialCapabilityAwareTaskMutator(
  input: TrialCapabilityAwareTaskMutatorInput,
): CapabilityAwareTaskMutator {
  return createCapabilityAwareTaskMutator({
    registry: input.registry,
    getTask: taskId => input.repository.getById(taskId),
    getActionable: () => input.repository.getActionable(),
    refresh: () => input.repository.refresh(),
    assertLock: (project, owner) => input.locks.assertHeld(project, owner),
    claimTask: lifecycleClaimTask,
    unclaimTask: lifecycleUnclaimTask,
    decomposeTask: lifecycleDecomposeTask,
    editTask: lifecycleEditTask,
    recordProposal: input.recordProposal,
    attemptReleaseAuthority: input.attemptReleaseAuthority,
    trialId: input.trialId,
    project: input.project,
    lockOwner: input.lockOwner,
  });
}
