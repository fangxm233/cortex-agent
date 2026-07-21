// input:  TASKS.yaml (core scanAllTasks), threadStore, pending-tracker, taskMutator
// output: recoverOrphanedClaims() — startup reconciliation of dispatch claims orphaned by a crash
// pos:    called once from entry/app.ts right after threadStore.markRunningAsFailedOnStartup.
//         A claimed task is invisible to the dispatcher (isActionable excludes claimed_by), so a
//         dispatch claim whose owner died with the server would otherwise stay in-progress forever
//         — stranding the task AND any manager thread suspended on it. Claims that legitimately
//         survive a restart are respected: a waiting/rate_limited thread that owns the task
//         (DR-0014 suspension, rate-limit pause), a remote cortex-run tracked in pending-tasks.json,
//         and manual (non-dispatcher) claims.
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { scanAllTasks, type Task } from '@core/task-parser.js';
import { threadStore } from '@store/thread-repo.js';
import { createLogger } from '@core/log.js';
import * as pendingTaskTracker from './pending-tracker.js';
import { taskMutator } from './mutator.js';

const log = createLogger('claim-recovery');

/** The claim identity the dispatcher uses (dispatcher.ts selectAndClaimTask). Only these
 *  claims are recovered — a human/agent manual claim is a deliberate hold, not a crash orphan. */
const DISPATCHER_AGENT = 'task-dispatcher';

/** Thread statuses that legitimately keep their task claimed across a restart:
 *  waiting = suspended manager (DR-0014), rate_limited = paused for auto-resume.
 *  'running' is included defensively — at the intended call site (startup, after
 *  markRunningAsFailedOnStartup) no running thread exists. */
const CLAIM_HOLDING_THREAD_STATUSES = new Set(['running', 'waiting', 'rate_limited']);

export interface ClaimRecoveryDeps {
  scan?: () => Task[];
  ownedByLiveThread?: (taskId: string) => boolean;
  isTracked?: (taskId: string) => boolean;
  unclaim?: (taskId: string) => Promise<unknown>;
}

/** Unclaim every dispatcher claim with no surviving owner. Returns the recovered task ids.
 *  Idempotent and fail-soft: one failing unclaim never aborts the sweep. */
export async function recoverOrphanedClaims(deps: ClaimRecoveryDeps = {}): Promise<string[]> {
  const scan = deps.scan ?? (() => scanAllTasks());
  const ownedByLiveThread = deps.ownedByLiveThread ?? ((taskId: string) =>
    threadStore.getAll().some((t) => CLAIM_HOLDING_THREAD_STATUSES.has(t.status) && t.metadata?.taskId === taskId));
  const isTracked = deps.isTracked ?? ((taskId: string) => pendingTaskTracker.getTask(taskId) !== null);
  const unclaim = deps.unclaim ?? ((taskId: string) => taskMutator.unclaim(taskId));

  let tasks: Task[];
  try {
    tasks = scan();
  } catch (e) {
    log.warn(`claim recovery skipped — task scan failed: ${(e as Error).message}`);
    return [];
  }

  const recovered: string[] = [];
  for (const task of tasks) {
    if (!task.id || task.claimed_by !== DISPATCHER_AGENT) continue;
    if (task.status === 'done' || task.status === 'pending') continue; // pending → cortex-run owns it
    if (task.blocked_by) continue;              // blocked is already a terminal signal for the tree
    if (ownedByLiveThread(task.id)) continue;   // suspended manager / rate-limit-paused thread
    if (isTracked(task.id)) continue;           // remote dispatch tracked in pending-tasks.json
    try {
      await unclaim(task.id);
      recovered.push(task.id);
      log.info(`recovered orphaned dispatch claim on [${task.project}] ${task.id} — task returned to the queue`);
    } catch (e) {
      log.warn(`failed to unclaim orphaned task ${task.id}: ${(e as Error).message}`);
    }
  }
  if (recovered.length > 0) log.info(`claim recovery: ${recovered.length} orphaned claim(s) released`);
  return recovered;
}
