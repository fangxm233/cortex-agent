import type { TaskInfo } from '@cortex-agent/ui-contract';

export function displayClaimId(task: TaskInfo): string | null {
  if (task.claimThreadId) return task.claimThreadId;
  return task.claimedBy?.startsWith('thr_') ? task.claimedBy : null;
}
