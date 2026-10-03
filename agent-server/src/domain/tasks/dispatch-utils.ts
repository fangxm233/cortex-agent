import type { TaskGenerationExpectation } from '@core/task-parser.js';
import { createLogger } from '@core/log.js';

const log = createLogger('dispatch-outcome');

// --- [SPLIT] outcome handling (DR-0014 task tree) ---

export interface SplitOutcome {
  handled: boolean;
  note?: string;
  error?: string;
}

interface SplitOutcomeArgs {
  threadId: string;
  taskId: string | null;
  project: string;
  ownership?: TaskGenerationExpectation;
}

interface SplitDetection {
  split: boolean;
  subtasks: any[] | null;
  error: string | null;
}

interface SplitOutcomeDeps {
  detect: (threadId: string) => SplitDetection;
  decompose: (
    project: string, text: string | null, subtasks: any[], taskId: string | null,
    options: { keepParent?: boolean; ownership?: TaskGenerationExpectation },
  ) => { success: boolean; message: string } | Promise<{ success: boolean; message: string }>;
  unclaim: (taskId: string) => Promise<unknown>;
}

async function invalidSplitOutcome(
  args: SplitOutcomeArgs, detection: SplitDetection, deps: SplitOutcomeDeps,
): Promise<SplitOutcome | null> {
  if (!args.taskId) {
    log.warn(`[SPLIT] marker in thread ${args.threadId} but no associated task — ignoring`);
    return { handled: false };
  }
  if (!detection.error && detection.subtasks) return null;
  await deps.unclaim(args.taskId);
  return { handled: true, error: detection.error || '[SPLIT] proposal empty' };
}

/** Process a worker thread's [SPLIT] proposal and preserve dispatch ownership. */
async function processSplitOutcome(
  args: SplitOutcomeArgs, deps: SplitOutcomeDeps,
): Promise<SplitOutcome> {
  const detection = deps.detect(args.threadId);
  if (!detection.split) return { handled: false };
  const invalid = await invalidSplitOutcome(args, detection, deps);
  if (invalid) return invalid;
  const ownershipOption = args.ownership ? { ownership: args.ownership } : {};
  const result = await deps.decompose(args.project, null, detection.subtasks!, args.taskId, {
    keepParent: true,
    ...ownershipOption,
  });
  if (!result.success) {
    await deps.unclaim(args.taskId!);
    return { handled: true, error: result.message };
  }
  await deps.unclaim(args.taskId!);
  return { handled: true, note: `split into ${detection.subtasks!.length} subtask(s) — parent kept as join node` };
}

// --- [ABORT] outcome handling (DR-0014 §8: worker escalation) ---

export interface AbortOutcome {
  handled: boolean;
  note?: string;
  error?: string;
}

/** Canonical block reason for a worker-aborted task. Single source so the runner's
 *  pre-onEnd block (DR-0015 problem 2) and processAbortOutcome produce byte-identical
 *  reasons — a second block with the same reason is a no-op commit (git porcelain sees no
 *  change), so blocking in both places is safe. */
export function formatWorkerAbortReason(raw: string | null): string {
  const r = (raw || 'no reason given').replace(/\s+/g, ' ').trim() || 'no reason given';
  return `worker-abort: ${r}`.slice(0, 280);
}

/** Process an aborted dispatch thread: the worker said "I can't" ([ABORT: <reason>]) —
 *  block the task with the abort reason. taskMutator.block publishes task.blocked, which
 *  wakes a manager thread waiting on this task (its parent re-plans); with no manager the
 *  block surfaces to humans/stage-gate as usual. Also fixes the pre-existing bug where
 *  aborted dispatch threads were finalized as successes (publishing a bogus task.completed).
 *  Not counted as a dispatch failure — abort is a judgment, not a fault. */
async function processAbortOutcome(
  args: { threadId: string; taskId: string | null; project: string },
  deps: {
    getThread: (threadId: string) => { status: string; abortReason: string | null } | null;
    block: (taskId: string, reason: string) => Promise<{ success: boolean; message: string }>;
  },
): Promise<AbortOutcome> {
  const thread = deps.getThread(args.threadId);
  if (!thread || thread.status !== 'aborted') return { handled: false };
  if (!args.taskId) {
    log.warn(`aborted thread ${args.threadId} has no associated task — ignoring`);
    return { handled: false };
  }
  const rawReason = (thread.abortReason || 'no reason given').replace(/\s+/g, ' ').trim();
  const reason = formatWorkerAbortReason(thread.abortReason);
  const result = await deps.block(args.taskId, reason);
  if (!result.success) {
    return { handled: true, error: result.message };
  }
  return { handled: true, note: `worker aborted — task blocked (${rawReason.slice(0, 120)})` };
}

export {
  processSplitOutcome,
  processAbortOutcome,
};
