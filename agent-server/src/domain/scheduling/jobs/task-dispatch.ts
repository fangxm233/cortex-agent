import * as os from 'node:os';
import { ctx, requireJobCtx } from '../job-registry.js';
import { createLogger } from '@core/log.js';
import { getSettings } from '@core/settings.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import { attestedProductionBenchmarkEvidenceContext } from '@core/production-benchmark-evidence.js';
import { Icons } from '../../../core/icons.js';
import * as executionRegistry from '../../executions/registry.js';

const log = createLogger('task-dispatch');
import * as pendingTaskTracker from '../../tasks/pending-tracker.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { selectAndClaimTask } from '../../tasks/dispatcher.js';
import { taskMutator } from '../../tasks/mutator.js';
import { recordProductionTopologyFact } from '../../tasks/production-topology-ledger.js';
import {
  clearPendingControl, createThread, detectSplitFromControl,
  getRootThreadId, resolveTaskParentThread,
} from '../../threads/index.js';
import { processSplitOutcome, processAbortOutcome, formatWorkerAbortReason } from '../../tasks/dispatch-utils.js';
import { threadStore } from '@store/thread-repo.js';
import { registerThreadSession } from './register-thread-session.js';
import type { Destination } from '@platform/index.js';
// Type-only, so `domain` still never depends on `orchestration` at runtime: the run itself
// arrives through `ctx.runThreadOnSurface`, injected by app.ts.
import type { TaskVerdict, ThreadRunOutcome, ThreadRunSurfaceInput } from '@orch/thread-run/index.js';

/** The precise shape of `ctx.runThreadOnSurface` — see the type's doc in job-registry for why it
 *  is re-declared here rather than named there. */
type RunOnSurface = (input: ThreadRunSurfaceInput) => Promise<ThreadRunOutcome>;

// --- Dispatch-failure quarantine ---

const DISPATCH_FAILURE_QUARANTINE_THRESHOLD = 3;
const dispatchFailureCounts = new Map<string, { count: number; lastError: string }>();

function sanitizeBlockReason(s: string): string {
  return String(s).replace(/[\r\n\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function recordDispatchTopology(
  project: string, taskId: string, generation: string | null, threadId: string,
): void {
  if (!generation) {
    log.warn(`topology ledger dispatch omitted for ${taskId}: generation unavailable`);
    return;
  }
  try {
    recordProductionTopologyFact({
      project, kind: 'dispatch', task_id: taskId,
      dispatch_generation: generation, thread_id: threadId,
    });
  } catch (error) {
    log.warn(`topology ledger dispatch record failed: ${(error as Error).message}`);
  }
}

// --- Guards ---

interface DispatchCycle { taskId: string | null; threadId: string | null }
const activeDispatchCycles = new Set<DispatchCycle>();

function resolveMaxConcurrent(): number {
  const configured = getSettings().taskDispatchMaxConcurrent;
  if (configured !== null) return configured;
  return Math.max(4, os.cpus().length - 2);
}

function countExternalDispatches(): number {
  const cycles = [...activeDispatchCycles];
  const localTaskIds = new Set(cycles.map((cycle) => cycle.taskId).filter(Boolean));
  const localThreadIds = new Set(cycles.map((cycle) => cycle.threadId).filter(Boolean));
  return executionRegistry.getRunningExecutions().filter((record) => {
    if (record.kind !== 'dispatch') return false;
    if (record.thread?.threadId && localThreadIds.has(record.thread.threadId)) return false;
    const taskId = record.dispatch?.taskId;
    return !taskId || !localTaskIds.has(taskId);
  }).length;
}

function reserveDispatchCycle(): DispatchCycle | null {
  const maxConcurrent = resolveMaxConcurrent();
  const activeCount = activeDispatchCycles.size + countExternalDispatches();
  if (activeCount >= maxConcurrent) {
    log.info(`Skipping — at concurrency limit (${activeCount}/${maxConcurrent})`);
    return null;
  }
  const cycle = { taskId: null, threadId: null };
  activeDispatchCycles.add(cycle);
  return cycle;
}

export function taskDispatchRunner({ channel, profileName }: { channel: string; profileName: string }): boolean {
  const cycle = reserveDispatchCycle();
  if (!cycle) return false;
  const bus = ctx.bus!;
  bus.publish({ type: 'llm.active-count-delta', delta: 1 });
  void runDispatchAsync({ channel, profileName, cycle }).finally(() => {
    activeDispatchCycles.delete(cycle);
    bus.publish({ type: 'llm.active-count-delta', delta: -1 });
  });
  return true;
}

async function runDispatchAsync({ channel, profileName, cycle }: {
  channel: string; profileName: string; cycle: DispatchCycle;
}): Promise<void> {
  const startTime = Date.now();
  let selectedTask: Record<string, any> | null = null;
  let outcome: CycleOutcome = { success: false, skipped: false, note: '' };

  try {
    // Step 1: Dry run — check there is a dispatchable task without claiming.
    // Rate-limit eligibility is decided per-task inside selection, against each task's
    // TEMPLATE profiles (profileName only resolves __active__ slots) — see dispatcher.ts.
    const preview = await selectAndClaimTask({ dryRun: true, profileName });
    if (!preview) {
      outcome = { success: false, skipped: true, note: 'No dispatchable tasks available' };
      return;
    }

    // Step 2: Real claim + execute
    const selected = await selectAndClaimTask({ profileName });
    if (!selected) {
      outcome = { success: false, skipped: true, note: 'No dispatchable tasks available' };
      return;
    }
    selectedTask = {
      ...selected.task,
      dispatch_generation: selected.dispatchGeneration ?? null,
    };
    cycle.taskId = selectedTask.id;
    ctx.bus!.publish({ type: 'task.claimed', taskId: selectedTask.id, by: 'task-dispatcher' });
    ctx.bus!.publish({ type: 'task.dispatched', taskId: selectedTask.id, machine: 'local' });
    outcome = await executeDispatchTask({ selected, selectedTask: selectedTask!, channel, profileName, startTime, cycle });
  } catch (error) {
    outcome = await handleDispatchError(error as Error, selectedTask, channel);
  } finally {
    log.info(`Cycle complete: ${outcome.note}`);
  }
}

interface CycleOutcome { success: boolean; skipped: boolean; note: string }

/** `decide`'s full answer: the verdict ThreadRun renders, plus what the CYCLE still has to do
 *  once the line is drawn — log it, publish `task.completed`, post the failure notice. ThreadRun
 *  only wants the verdict, so the wrapper closure keeps the rest. */
interface DispatchDecision {
  verdict: TaskVerdict;
  cycle: CycleOutcome;
  /** The task terminated successfully → publish `task.completed` after the "Done" line. */
  completed?: boolean;
  /** `blocked` = quarantine already blocked the task, which picks the notice's wording. */
  failure?: { error: Error; blocked: boolean };
}

function dispatchDestination(projectId: string): Destination {
  return { type: 'project-report', projectId, trigger: 'task-dispatch', sessionId: '' };
}

async function executeDispatchTask({ selected, selectedTask, channel, profileName, startTime, cycle }: {
  selected: Record<string, any>; selectedTask: Record<string, any>; channel: string;
  profileName: string; startTime: number; cycle: DispatchCycle;
}): Promise<CycleOutcome> {
  const runThreadOnSurface = requireJobCtx('runThreadOnSurface') as RunOnSurface;
  const ownership = { generation: selected.dispatchGeneration ?? null };
  const sessionName = await sessionStore.generateSessionName();
  const effectiveProfile = profileName;
  const destination = dispatchDestination(selectedTask.project || channel);

  if (!selected.template) {
    log.error(`Task [${selectedTask.project}] ${selectedTask.text.substring(0, 60)} missing required [template:] tag — skipping`);
    await taskMutator.unclaim(selectedTask.id, { ownership });
    return { success: false, skipped: true, note: 'Task missing required [template:] tag' };
  }
  const parentThread = selectedTask.parent
    ? resolveTaskParentThread(selectedTask.project, selectedTask.parent)
    : null;
  if (selectedTask.parent && !parentThread) {
    throw new Error(`Persisted parent manager thread is missing for task ${selectedTask.parent}`);
  }
  // A descendant inherits its manager's context; a root task has no parent to inherit from and no
  // request body to carry one, so it adopts whatever the launcher attested for this home (null
  // outside a production benchmark trial).
  const evidenceContext = parentThread
    ? parentThread.metadata?.productionBenchmarkEvidenceContext
    : attestedProductionBenchmarkEvidenceContext();
  const thread = createThread(channel, {
    templateName: selected.template, userMessage: selected.prompt, userMessageTs: `dispatch_${Date.now()}`,
    // The status line is posted by ThreadRun a moment from now and becomes this thread's platform
    // root then (`claimPlatformThread`), which is where createThread used to stamp it from.
    platformThreadId: null,
    projectId: selectedTask.project,
    metadata: {
      trigger: 'task-dispatch', profileOverride: effectiveProfile,
      taskId: selectedTask.id ?? null, taskProject: selectedTask.project ?? null,
      dispatchGeneration: selected.dispatchGeneration ?? null,
      taskText: selectedTask.text ?? null,
      resumeDest: 'project-report',
      ...(parentThread ? {
        parentThreadId: parentThread.id,
        rootThreadId: getRootThreadId(parentThread),
      } : {}),
      ...(evidenceContext ? { productionBenchmarkEvidenceContext: evidenceContext } : {}),
    },
  });
  cycle.threadId = thread.id;
  recordDispatchTopology(
    selectedTask.project, selectedTask.id, selected.dispatchGeneration ?? null, thread.id,
  );

  void emitCortexEvent('cortex:dispatch.started', {
    taskId: selectedTask.id,
    project: selectedTask.project,
    source: 'task-dispatch',
    templateName: selected.template,
  }).catch(() => {});

  let decision: DispatchDecision | null = null;
  const outcome = await runThreadOnSurface({
    threadId: thread.id,
    mode: { kind: 'start' },
    channel,
    destination,
    threadAnchorId: null,
    claimPlatformThread: true,
    statusMessage: null,
    render: {
      kind: 'task', flavour: 'dispatch', project: selectedTask.project,
      taskText: selectedTask.text ?? null, sessionName, profileName: effectiveProfile,
    },
    interactive: true,
    startTime,
    settle: null,
    // Block the owning task before lifecycle end hooks inspect task state.
    onAbort: async ({ taskId, reason }) => {
      await taskMutator.block(taskId, formatWorkerAbortReason(reason), { ownership });
    },
    decide: async (o) => {
      decision = await decideDispatch(o, { threadId: thread.id, selectedTask, channel, sessionName, ownership });
      return decision.verdict;
    },
  });

  // `decide` itself threw (ThreadRun contained it and reported it on `outcome.error`): whatever
  // bookkeeping it was doing is unfinished, so account the failure the way the cycle's outer
  // catch always has — count it, quarantine at the threshold, release the claim — then announce.
  const settled: DispatchDecision = decision ?? await (async (): Promise<DispatchDecision> => {
    const error = outcome.error ?? new Error('unknown');
    const blocked = await accountDispatchFailure(error, selectedTask);
    return {
      verdict: { kind: 'error', message: error.message },
      cycle: { success: false, skipped: false, note: `Error: ${error.message}${blocked ? ' (blocked)' : ''}` },
      failure: { error, blocked },
    };
  })();

  // Ordered as it has always been: the "Done" line lands before the completion event, and the
  // failure notice after the quarantine bookkeeping `decide` just did.
  if (settled.completed && selectedTask.id) {
    ctx.bus!.publish({
      type: 'task.completed', taskId: selectedTask.id,
      dispatchGeneration: selected.dispatchGeneration ?? null,
    });
  }
  if (settled.failure) {
    await postDispatchErrorNotice(destination, selectedTask, settled.failure.error, settled.failure.blocked);
  }
  return settled.cycle;
}

/**
 * Turn a finished dispatch thread into a verdict about the TASK — and perform every task effect
 * that verdict asserts, BEFORE anything is rendered (plan §4: a status line must never claim a
 * block / unclaim / decompose that has not happened). The branch order is the shipped one:
 * failure → suspended → abort → split → rate-limit pause → fallbacks exhausted → success.
 */
async function decideDispatch(outcome: ThreadRunOutcome, c: {
  threadId: string; selectedTask: Record<string, any>; channel: string;
  sessionName: string; ownership: { generation: string | null };
}): Promise<DispatchDecision> {
  const { threadId, selectedTask, ownership } = c;
  const project = selectedTask.project;

  if (outcome.error) {
    const blocked = await accountDispatchFailure(outcome.error, selectedTask);
    return {
      verdict: { kind: 'error', message: outcome.error.message },
      cycle: { success: false, skipped: false, note: `Error: ${outcome.error.message}${blocked ? ' (blocked)' : ''}` },
      failure: { error: outcome.error, blocked },
    };
  }

  // A suspended thread is not complete. Keep the task claimed until resumed termination;
  // do not finalize or publish task.completed.
  if (outcome.verdict === 'waiting') {
    const metadata = outcome.result?.thread?.metadata;
    const nThreads = metadata?.waitingOn?.length ?? 0;
    const nTasks = metadata?.waitingOnTasks?.length ?? 0;
    // DR-0014 §8: close the suspension race window (a child task that turned terminal
    // between the snapshot and the waiting persist fired its event unheard).
    if (nTasks > 0 && ctx.onThreadSuspended) {
      await ctx.onThreadSuspended(threadId).catch((e) => log.error(`onThreadSuspended: ${(e as Error).message}`));
    }
    return {
      verdict: { kind: 'suspended', childThreads: nThreads, childTasks: nTasks },
      cycle: {
        success: true, skipped: false,
        note: `Suspended [${project}] waiting on ${nThreads} thread(s) + ${nTasks} task(s)`,
      },
    };
  }

  // DR-0014 §8: worker escalation — [ABORT: <reason>] blocks the task (task.blocked event
  // wakes the waiting manager, if any). Must run BEFORE the success branch: aborted
  // threads were previously finalized as successes and published a bogus task.completed.
  const abortOutcome = await processAbortOutcome(
    { threadId, taskId: selectedTask.id ?? null, project },
    {
      getThread: (id) => threadStore.get(id),
      block: (tid, reason) => taskMutator.block(tid, reason, { ownership }),
    },
  );
  if (abortOutcome.handled) {
    if (selectedTask.id) dispatchFailureCounts.delete(selectedTask.id); // abort is judgment, not fault
    return {
      verdict: { kind: 'aborted', note: abortOutcome.note ?? '', blockError: abortOutcome.error ?? null },
      cycle: {
        success: !abortOutcome.error, skipped: false,
        note: abortOutcome.error ? `abort-block failed: ${abortOutcome.error}` : `[${project}] ${abortOutcome.note}`,
      },
    };
  }

  // DR-0014: the worker proposed a decomposition (thread_split) instead of doing the task.
  // The signal rides on metadata.pendingControl (DR-0015 problem 1), read via detectSplitFromControl.
  // Decompose keep-parent (task becomes the join/acceptance node) and unclaim; the children flow
  // through the normal dispatch queue.
  const splitOutcome = await processSplitOutcome(
    { threadId, taskId: selectedTask.id ?? null, project, ownership },
    {
      detect: detectSplitFromControl,
      // system:true — no agent lock in the dispatch path; defer if a foreign lock exists.
      decompose: (pr, t, subs, tid, opts) => taskMutator.decompose(pr, t, subs, tid, { ...opts, system: true }),
      unclaim: (tid) => taskMutator.unclaim(tid, { ownership }),
    },
  );
  if (splitOutcome.handled) {
    // Control intent consumed — clear it so a re-read never re-fires.
    await clearPendingControl(threadId);
    return {
      verdict: { kind: 'split', note: splitOutcome.note ?? '', error: splitOutcome.error ?? null },
      cycle: splitOutcome.error
        ? { success: false, skipped: false, note: `[SPLIT] invalid: ${splitOutcome.error}` }
        : { success: true, skipped: false, note: `[${project}] ${splitOutcome.note}` },
    };
  }

  // Rate-limit pause keeps the task claimed so a fresh dispatch cannot race the resumed thread.
  // Do not publish completion or finalize until the resumed thread truly terminates.
  if (outcome.verdict === 'rate_limited') {
    return {
      verdict: { kind: 'paused' },
      cycle: { success: true, skipped: false, note: `Paused [${project}] — rate limited, will auto-resume` },
    };
  }

  if (outcome.verdict === 'rate_limited_exhausted') {
    // Fallback: rate-limited but no active throttle, so the runner did not pause the thread.
    await taskMutator.unclaim(selectedTask.id, { ownership });
    return {
      verdict: { kind: 'exhausted' },
      cycle: { success: false, skipped: false, note: 'Rate limited — all fallbacks exhausted' },
    };
  }

  await registerThreadSession(c.channel, {
    sessionName: c.sessionName,
    result: (outcome.result?.lastAgentResult ?? null) as any,
    threadResult: (outcome.result ?? {}) as Record<string, any>,
    project, label: selectedTask.text?.substring(0, 60) || null,
    sessionKind: 'scheduled', sessionOrigin: 'thread',
  });
  if (selectedTask.id) dispatchFailureCounts.delete(selectedTask.id);
  return {
    verdict: { kind: 'done' },
    cycle: {
      success: true, skipped: false,
      note: `Completed [${project}] ${selectedTask.text?.substring(0, 60)}`,
    },
    completed: !!selectedTask.id,
  };
}

/** Counts this failure and, at the threshold, blocks the task. Runs BEFORE the claim is
 *  released: block() clears claimed_by itself, and its ownership check only passes while
 *  this dispatch's generation is still the task's own — unclaim() nulls that generation,
 *  so quarantining afterwards is refused as stale and the task loops forever. */
async function quarantineAfterFailure(taskId: string, ownership: { generation: string | null }, error: Error): Promise<boolean> {
  const prev = dispatchFailureCounts.get(taskId) || { count: 0, lastError: '' };
  const next = { count: prev.count + 1, lastError: error.message };
  dispatchFailureCounts.set(taskId, next);
  if (next.count < DISPATCH_FAILURE_QUARANTINE_THRESHOLD) return false;
  const blockReason = sanitizeBlockReason(`dispatch-failed-${next.count}x: ${error.message}`);
  try {
    const blockResult = await taskMutator.block(taskId, blockReason, { ownership });
    if (blockResult.success) {
      dispatchFailureCounts.delete(taskId);
      return true;
    }
    log.error(`Failed to auto-block task ${taskId}: ${blockResult.message}`);
  } catch (e) {
    log.error(`Failed to auto-block task ${taskId}: ${(e as Error).message}`);
  }
  return false;
}

/**
 * The one dispatch-failure notice, for both the failures that happen BEFORE a thread exists
 * (selection, a missing parent manager, createThread) and the ones inside the run. A failed
 * dispatch has never touched its status line — it stays on "Dispatching…" — so this is a fresh
 * project post rather than a render, which is why it lives here and not in render-task.ts.
 */
async function postDispatchErrorNotice(destination: Destination, selectedTask: Record<string, any> | null, error: Error, blocked: boolean): Promise<void> {
  const notify = requireJobCtx('notify');
  const text = blocked && selectedTask
    ? `${Icons.blocked} Auto-blocked after ${DISPATCH_FAILURE_QUARANTINE_THRESHOLD} consecutive dispatch failures. Reason recorded in TASKS.yaml. Task: [${selectedTask.project}] ${String(selectedTask.text).substring(0, 80)}. Last error: ${error.message}. Unblock with \`cortex-task unblock --task-id ${selectedTask.id}\`.`
    : `${Icons.error} Task dispatch error: ${error.message}`;
  try {
    await notify(destination, text);
  } catch {}
}

/** Count the failure, quarantine at the threshold, and release the claim otherwise. Returns
 *  whether the task ended up blocked (which decides the notice above). */
async function accountDispatchFailure(error: Error, selectedTask: Record<string, any> | null): Promise<boolean> {
  log.error(`Error: ${error.message}`);
  const ownership = { generation: selectedTask?.dispatch_generation ?? null };
  const blocked = selectedTask?.id
    ? await quarantineAfterFailure(selectedTask.id, ownership, error)
    : false;
  // A blocked task is already released by block(); only a task going back to the queue
  // needs its claim dropped.
  if (selectedTask && !blocked) {
    try { await taskMutator.unclaim(selectedTask.id, { ownership }); }
    catch (e) { log.error(`Failed to unclaim task: ${(e as Error).message}`); }
  }
  return blocked;
}

/** The cycle's outer catch: everything that went wrong before the run had a thread to report on. */
async function handleDispatchError(error: Error, selectedTask: Record<string, any> | null, channel: string): Promise<CycleOutcome> {
  const blocked = await accountDispatchFailure(error, selectedTask);
  await postDispatchErrorNotice(
    dispatchDestination(selectedTask?.project || channel), selectedTask, error, blocked,
  );
  return { success: false, skipped: false, note: `Error: ${error.message}${blocked ? ' (blocked)' : ''}` };
}

// --- Cancel dispatched task ---

export async function cancelDispatchedTask({ taskId, channel }: { taskId: string; channel: string }): Promise<{ ok: boolean; message: string }> {
  try {
    executionRegistry.cancelExecutionByTaskId(taskId);
    pendingTaskTracker.clearTask(taskId);
    return { ok: true, message: `${Icons.stopped} Cancelled task [${taskId}].` };
  } catch (error) {
    return { ok: false, message: `Failed to cancel \`${taskId}\`: ${(error as Error).message}` };
  }
}

export function _testResetDispatchCycles(): void {
  activeDispatchCycles.clear();
}
