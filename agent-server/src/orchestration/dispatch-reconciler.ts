// input:  enable setting, execution and pending-task state
// output: guarded stale-dispatch reconciliation interval
// pos:    Periodic dispatch recovery registration
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import * as executionRegistry from '@domain/executions/registry.js';
import * as pendingTaskTracker from '@domain/tasks/pending-tracker.js';
import { runningExecutions } from '@core/running-executions.js';

const RECONCILE_INTERVAL_MS = 2 * 60 * 1000;
// Crash-orphan grace: a dispatch that is neither pending-remote nor live-in-process for this long
// is treated as a crashed in-process orphan and reaped (frees a concurrency slot in minutes).
const DISPATCH_ORPHAN_GRACE_MS = 2 * 60 * 1000;
// Hard ceiling for a still-live but wedged dispatch.
const DISPATCH_STALE_AGE_MS = 3 * 60 * 60 * 1000;

export function startDispatchReconciler(enabled: boolean): void {
  if (!enabled) return;
  setInterval(() => {
    executionRegistry.reconcileStaleDispatches({
      isTaskPending: (taskId) => pendingTaskTracker.getTask(taskId) !== null,
      isLive: (executionId) => runningExecutions.getById(executionId) !== null,
      graceMs: DISPATCH_ORPHAN_GRACE_MS,
      maxAgeMs: DISPATCH_STALE_AGE_MS,
    });
  }, RECONCILE_INTERVAL_MS);
}
