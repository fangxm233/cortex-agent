// input:  UiServiceDeps + task action args
// output: claim/unclaim/complete/block/unblock handlers → Ok<void> | Err
// pos:    mutate handlers for 'tasks.{claim,unclaim,complete,block,unblock}'

import { taskMutator } from '@domain/tasks/mutator.js';
import { acquireLockAsync, releaseLockAsync, getOwnerIdentity } from '@domain/tasks/system/task-lock.js';
import type { UiServiceDeps, Result } from '../types.js';

async function withTaskLock<T>(
  deps: UiServiceDeps,
  projectId: string,
  fn: () => Promise<T>,
): Promise<Result<T>> {
  const owner = getOwnerIdentity();
  // Async lock: the UI mutation must not park the event loop while another process holds the lock.
  const acq = await acquireLockAsync(projectId, { owner });
  if (!acq.acquired) {
    return { ok: false, code: 'task-lock-busy', message: acq.message || 'Task lock is busy' };
  }
  try {
    const result = await fn();
    return { ok: true, data: result };
  } finally {
    await releaseLockAsync(projectId, owner);
  }
}

export async function handleClaimTask(
  deps: UiServiceDeps,
  args: { projectId: string; taskId: string },
): Promise<Result<void>> {
  return withTaskLock(deps, args.projectId, async () => {
    const result = await taskMutator.claim(args.taskId, getOwnerIdentity());
    if (!result.success) {
      throw new Error(result.message || 'Claim failed');
    }
  });
}

export async function handleUnclaimTask(
  deps: UiServiceDeps,
  args: { projectId: string; taskId: string },
): Promise<Result<void>> {
  return withTaskLock(deps, args.projectId, async () => {
    const result = await taskMutator.unclaim(args.taskId);
    if (!result.success) {
      throw new Error(result.message || 'Unclaim failed');
    }
  });
}

export async function handleCompleteTask(
  deps: UiServiceDeps,
  args: { projectId: string; taskId: string; note?: string },
): Promise<Result<void>> {
  return withTaskLock(deps, args.projectId, async () => {
    const result = await taskMutator.complete(args.taskId, args.note);
    if (!result.success) {
      throw new Error(result.message || 'Complete failed');
    }
  });
}

export async function handleBlockTask(
  deps: UiServiceDeps,
  args: { projectId: string; taskId: string; reason: string },
): Promise<Result<void>> {
  return withTaskLock(deps, args.projectId, async () => {
    const result = await taskMutator.block(args.taskId, args.reason);
    if (!result.success) {
      throw new Error(result.message || 'Block failed');
    }
  });
}

export async function handleUnblockTask(
  deps: UiServiceDeps,
  args: { projectId: string; taskId: string },
): Promise<Result<void>> {
  return withTaskLock(deps, args.projectId, async () => {
    const result = await taskMutator.unblock(args.taskId);
    if (!result.success) {
      throw new Error(result.message || 'Unblock failed');
    }
  });
}
