// input:  TASKS.yaml generations, threadStore, pending-tracker, taskMutator
// output: generation-fenced startup reconciliation of orphaned dispatch claims
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
  ownedByLiveThread?: (task: Task) => boolean;
  isTracked?: (task: Task) => boolean;
  unclaim?: (taskId: string, generation: string | null) => Promise<unknown>;
}

/** Unclaim every dispatcher claim with no surviving owner. Returns the recovered task ids.
 *  Idempotent and fail-soft: one failing unclaim never aborts the sweep. */
export async function recoverOrphanedClaims(deps: ClaimRecoveryDeps = {}): Promise<string[]> {
  const scan = deps.scan ?? (() => scanAllTasks());
  const ownedByLiveThread = deps.ownedByLiveThread ?? ((task: Task) =>
    threadStore.getAll().some((t) => CLAIM_HOLDING_THREAD_STATUSES.has(t.status)
      && t.metadata?.taskId === task.id
      && (t.metadata?.dispatchGeneration ?? null) === task.dispatch_generation));
  const isTracked = deps.isTracked ?? ((task: Task) => pendingTaskTracker.isTaskTracked(
    task.id!, task.project, task.dispatch_generation,
  ));
  const unclaim = deps.unclaim ?? ((taskId: string, generation: string | null) =>
    taskMutator.unclaim(taskId, { ownership: { generation } }));

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
    if (ownedByLiveThread(task)) continue;      // suspended manager / rate-limit-paused thread
    if (isTracked(task)) continue;              // remote dispatch tracked in pending-tasks.json
    try {
      const result = await unclaim(task.id, task.dispatch_generation);
      if ((result as any)?.success === false) continue;
      recovered.push(task.id);
      log.info(`recovered orphaned dispatch claim on [${task.project}] ${task.id} — task returned to the queue`);
    } catch (e) {
      log.warn(`failed to unclaim orphaned task ${task.id}: ${(e as Error).message}`);
    }
  }
  if (recovered.length > 0) log.info(`claim recovery: ${recovered.length} orphaned claim(s) released`);
  return recovered;
}
