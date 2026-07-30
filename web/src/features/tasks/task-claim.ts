// input:  Task claim owner and optional owning thread id
// output: Safe claim identifier for UI presentation
// pos:    Shared task-claim display helper
// >>> If I am updated, update my header comment and CORTEX.md <<<

import type { TaskInfo } from '@cortex-agent/ui-contract';

export function displayClaimId(task: TaskInfo): string | null {
  if (task.claimThreadId) return task.claimThreadId;
  return task.claimedBy?.startsWith('thr_') ? task.claimedBy : null;
}
