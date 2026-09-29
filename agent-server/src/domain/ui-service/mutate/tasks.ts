import { t } from '@core/i18n.js';
import { taskMutator } from '@domain/tasks/mutator.js';
import { acquireLockAsync, releaseLockAsync, getOwnerIdentity } from '@domain/tasks/system/task-lock.js';
import type { UiServiceDeps, Result } from '../types.js';

async function withTaskLock<T>(
  projectId: string,
  fn: () => Promise<T>,
): Promise<Result<T>> {
  const owner = getOwnerIdentity();
  // Async lock: the UI mutation must not park the event loop while another process holds the lock.
  const acq = await acquireLockAsync(projectId, { owner });
  if (!acq.acquired) {
    return { ok: false, code: 'task-lock-busy', message: acq.message || t('ui.task.lockBusy') };
  }
  try {
    const result = await fn();
    return { ok: true, data: result };
  } finally {
    await releaseLockAsync(projectId, owner);
  }
}

export async function handleClaimTask(
  _deps: UiServiceDeps,
  args: { projectId: string; taskId: string },
): Promise<Result<void>> {
  return withTaskLock(args.projectId, async () => {
    const result = await taskMutator.claim(args.taskId, getOwnerIdentity());
    if (!result.success) {
      throw new Error(result.message || t('ui.task.claimFailed'));
    }
  });
}

export async function handleUnclaimTask(
  _deps: UiServiceDeps,
  args: { projectId: string; taskId: string },
): Promise<Result<void>> {
  return withTaskLock(args.projectId, async () => {
    const result = await taskMutator.unclaim(args.taskId);
    if (!result.success) {
      throw new Error(result.message || t('ui.task.unclaimFailed'));
    }
  });
}

export async function handleCompleteTask(
  _deps: UiServiceDeps,
  args: { projectId: string; taskId: string; note?: string },
): Promise<Result<void>> {
  return withTaskLock(args.projectId, async () => {
    const result = await taskMutator.complete(args.taskId, args.note);
    if (!result.success) {
      throw new Error(result.message || t('ui.task.completeFailed'));
    }
  });
}

export async function handleBlockTask(
  _deps: UiServiceDeps,
  args: { projectId: string; taskId: string; reason: string },
): Promise<Result<void>> {
  return withTaskLock(args.projectId, async () => {
    const result = await taskMutator.block(args.taskId, args.reason);
    if (!result.success) {
      throw new Error(result.message || t('ui.task.blockFailed'));
    }
  });
}

export async function handleUnblockTask(
  _deps: UiServiceDeps,
  args: { projectId: string; taskId: string },
): Promise<Result<void>> {
  return withTaskLock(args.projectId, async () => {
    const result = await taskMutator.unblock(args.taskId);
    if (!result.success) {
      throw new Error(result.message || t('ui.task.unblockFailed'));
    }
  });
}
