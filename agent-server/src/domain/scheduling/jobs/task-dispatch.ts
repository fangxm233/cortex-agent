// input:  task store, execution registry, thread runner, HookBus
// output: dispatch.started{taskId,project,source,templateName}
// pos:    Claims tasks and starts dispatch-tagged threads
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as os from 'node:os';
import { register, ctx } from '../job-registry.js';
import { createLogger } from '@core/log.js';
import { emitCortexEvent } from '@core/hook-bus.js';
import { Icons } from '../../../core/icons.js';
import * as executionRegistry from '../../executions/registry.js';

const log = createLogger('task-dispatch');
import * as pendingTaskTracker from '../../tasks/pending-tracker.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { getActiveProfile, getActiveBackend } from '../../agents/index.js';
import { selectAndClaimTask, computeNextInterval, updateScheduleInterval } from '../../tasks/dispatcher.js';
import { taskStore } from '../../tasks/store.js';
import { taskMutator } from '../../tasks/mutator.js';
import { createThread, detectSplitFromControl, clearPendingControl } from '../../threads/index.js';
import { runThread as runThreadExec } from '../../threads/runner.js';
import { processSplitOutcome, processAbortOutcome, formatWorkerAbortReason } from '../../tasks/dispatch-utils.js';
import { threadStore } from '@store/thread-repo.js';
import { buildUserProcessingMessage, computeElapsed, buildSessionTag } from '@core/status-format.js';
import { finalizeThreadSuccess } from './_shared.js';
import type { PlatformAdapter, MessageRef } from '@platform/index.js';
import { getOutboundQueue, durableUpdate, durablePost } from '@store/outbound-queue.js';

// --- Dispatch-failure quarantine ---

const DISPATCH_FAILURE_QUARANTINE_THRESHOLD = 3;
const dispatchFailureCounts = new Map<string, { count: number; lastError: string }>();

function sanitizeBlockReason(s: string): string {
  return String(s).replace(/[\r\n\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// --- Guards ---

// Max concurrent task dispatches. Resolution order:
//   1. TASK_DISPATCH_MAX_CONCURRENT env var (explicit override — used as-is if a positive int)
//   2. auto: max(4, os.cpus().length - 2) — scale to all-but-2 cores, floored at 4
function resolveMaxConcurrent(): number {
  const raw = process.env.TASK_DISPATCH_MAX_CONCURRENT;
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) {
      log.info(`Max concurrent dispatch = ${n} (from TASK_DISPATCH_MAX_CONCURRENT env)`);
      return n;
    }
    log.warn(`Invalid TASK_DISPATCH_MAX_CONCURRENT="${raw}" — falling back to auto`);
  }
  const cpus = os.cpus().length;
  const auto = Math.max(4, cpus - 2);
  log.info(`Max concurrent dispatch = ${auto} (auto: max(4, ${cpus} cpus - 2))`);
  return auto;
}

const TASK_DISPATCH_MAX_CONCURRENT = resolveMaxConcurrent();

function passDispatchGuards(): boolean {
  const runningExecutions = executionRegistry.getRunningExecutions();
  const runningDispatches = runningExecutions.filter(r => r.kind === 'dispatch').length;
  if (runningDispatches >= TASK_DISPATCH_MAX_CONCURRENT) {
    log.info(`Skipping — at concurrency limit (${runningDispatches}/${TASK_DISPATCH_MAX_CONCURRENT})`);
    return false;
  }
  return true;
}

// --- Public entry point (non-async fire-and-forget) ---

export function taskDispatchRunner({ channel, scheduleTaskId, profileName }: { channel: string; scheduleTaskId: string; profileName: string }): void {
  if (!passDispatchGuards()) return;

  ctx.bus!.publish({ type: 'llm.active-count-delta', delta: 1 });
  runDispatchAsync({ channel, scheduleTaskId, profileName }).finally(() => {
    ctx.bus!.publish({ type: 'llm.active-count-delta', delta: -1 });
  });
}

// --- Async implementation ---

async function runDispatchAsync({ channel, scheduleTaskId, profileName }: { channel: string; scheduleTaskId: string; profileName: string }): Promise<void> {
  const startTime = Date.now();
  let selectedTask: Record<string, any> | null = null;
  let outcome: { success: boolean; skipped: boolean; note: string } = { success: false, skipped: false, note: '' };

  try {
    // Step 1: Dry run — check there is a dispatchable task without claiming.
    // Rate-limit eligibility is decided per-task inside selection, against each task's
    // TEMPLATE profiles (profileName only resolves __active__ slots) — see dispatcher.ts.
    const preview = await selectAndClaimTask({ scheduleTaskId, dryRun: true, profileName });
    if (!preview) {
      outcome = { success: false, skipped: true, note: 'No dispatchable tasks available' };
      return;
    }

    // Step 2: Real claim + execute
    const selected = await selectAndClaimTask({ scheduleTaskId, profileName });
    if (!selected) {
      outcome = { success: false, skipped: true, note: 'No dispatchable tasks available' };
      return;
    }
    selectedTask = selected.task;
    ctx.bus!.publish({ type: 'task.claimed', taskId: selectedTask.id, by: 'task-dispatcher' });
    ctx.bus!.publish({ type: 'task.dispatched', taskId: selectedTask.id, machine: 'local' });
    outcome = await executeDispatchTask({ selected, selectedTask: selectedTask!, channel, scheduleTaskId, profileName, startTime });
  } catch (error) {
    outcome = await handleDispatchError(error as Error, selectedTask, channel);
  } finally {
    if (ctx.schedulerRef) {
      try { await updateScheduleInterval(ctx.schedulerRef, scheduleTaskId, computeNextInterval(outcome)); } catch {}
    }
    log.info(`Cycle complete: ${outcome.note}`);
  }
}

async function executeDispatchTask({ selected, selectedTask, channel, scheduleTaskId, profileName, startTime }: {
  selected: Record<string, any>; selectedTask: Record<string, any>; channel: string; scheduleTaskId: string; profileName: string; startTime: number;
}): Promise<{ success: boolean; skipped: boolean; note: string }> {
  const adapter = ctx.adapter!;
  const sessionName = await sessionStore.generateSessionName();
  const effectiveProfile = profileName;

  let statusMsg: MessageRef | null = null;
  try {
    statusMsg = await adapter.postMessage({ type: 'project-report', projectId: selectedTask.project || channel, trigger: 'task-dispatch', sessionId: '' }, {
      text: `${Icons.satellite} Dispatching: [${selectedTask.project}] ${selectedTask.text.substring(0, 80)}... | ${sessionName} | ${effectiveProfile}`,
    });
  } catch {}

  if (!selected.template) {
    log.error(`Task [${selectedTask.project}] ${selectedTask.text.substring(0, 60)} missing required [template:] tag — skipping`);
    await taskMutator.unclaim(selectedTask.id);
    return { success: false, skipped: true, note: 'Task missing required [template:] tag' };
  }
  const thread = createThread(channel, {
    templateName: selected.template, userMessage: selected.prompt, userMessageTs: `dispatch_${Date.now()}`,
    platformThreadId: statusMsg?.messageId ?? null,
    projectId: selectedTask.project,
    metadata: {
      scheduleTaskId, trigger: 'task-dispatch', profileOverride: effectiveProfile,
      taskId: selectedTask.id ?? null, taskProject: selectedTask.project ?? null,
      taskText: selectedTask.text ?? null,
      resumeDest: 'project-report',
    },
  });

  const icb = ctx.buildInteractiveCallbacks?.(channel, null);
  void emitCortexEvent('cortex:dispatch.started', {
    taskId: selectedTask.id,
    project: selectedTask.project,
    source: 'task-dispatch',
    templateName: selected.template,
  }).catch(() => {});
  const threadResult = await runThreadExec(thread.id, {
    adapter, channel: channel, threadAnchorId: statusMsg?.messageId || null, statusMsg, startTime,
    destination: { type: 'project-report', projectId: selectedTask.project || channel, trigger: 'task-dispatch', sessionId: '' },
    onToolUse: icb?.onToolUse ?? null, onPlanWritten: icb?.onPlanWritten ?? null, onAskUserQuestion: icb?.onAskUserQuestion ?? null,
    // Block the owning task before lifecycle end hooks inspect task state.
    onAbort: async ({ taskId, reason }) => { await taskMutator.block(taskId, formatWorkerAbortReason(reason)); },
  });
  const result = threadResult.lastAgentResult as any;

  // A suspended thread is not complete. Keep the task claimed until resumed termination;
  // do not finalize or publish task.completed.
  if (threadResult.thread?.status === 'waiting') {
    const nThreads = threadResult.thread.metadata?.waitingOn?.length ?? 0;
    const nTasks = threadResult.thread.metadata?.waitingOnTasks?.length ?? 0;
    // DR-0014 §8: close the suspension race window (a child task that turned terminal
    // between the snapshot and the waiting persist fired its event unheard).
    if (nTasks > 0 && ctx.onThreadSuspended) {
      await ctx.onThreadSuspended(thread.id).catch((e) => log.error(`onThreadSuspended: ${(e as Error).message}`));
    }
    if (statusMsg) {
      // Persist the live status message so the post-resume settle can refresh it.
      await threadStore.mutate(thread.id, (t) => { (t.metadata ??= {}).statusMsgRef = statusMsg; });
      const parts = [nThreads > 0 ? `${nThreads} child thread(s)` : null, nTasks > 0 ? `${nTasks} child task(s)` : null].filter(Boolean);
      const text = `${Icons.processing} [${selectedTask.project}] ${selectedTask.text.substring(0, 80)} | suspended — waiting on ${parts.join(' + ') || 'children'}`;
      const queue = getOutboundQueue();
      if (queue) { await durableUpdate(queue, adapter, statusMsg, { text }); }
      else { await adapter.updateMessage(statusMsg, { text }).catch(() => {}); }
    }
    return { success: true, skipped: false, note: `Suspended [${selectedTask.project}] waiting on ${nThreads} thread(s) + ${nTasks} task(s)` };
  }

  // DR-0014 §8: worker escalation — [ABORT: <reason>] blocks the task (task.blocked event
  // wakes the waiting manager, if any). Must run BEFORE finalizeThreadSuccess: aborted
  // threads were previously finalized as successes and published a bogus task.completed.
  const abortOutcome = await processAbortOutcome(
    { threadId: thread.id, taskId: selectedTask.id ?? null, project: selectedTask.project },
    {
      getThread: (id) => threadStore.get(id),
      block: (tid, reason) => taskMutator.block(tid, reason),
    },
  );
  if (abortOutcome.handled) {
    const text = abortOutcome.error
      ? `${Icons.error} [${selectedTask.project}] ${selectedTask.text.substring(0, 80)} | worker aborted but block failed: ${abortOutcome.error}`
      : `${Icons.stopped} [${selectedTask.project}] ${selectedTask.text.substring(0, 80)} | ${abortOutcome.note}`;
    if (statusMsg) {
      const queue = getOutboundQueue();
      if (queue) { await durableUpdate(queue, adapter, statusMsg, { text }); }
      else { await adapter.updateMessage(statusMsg, { text }).catch(() => {}); }
    }
    if (selectedTask.id) dispatchFailureCounts.delete(selectedTask.id); // abort is judgment, not fault
    return { success: !abortOutcome.error, skipped: false, note: abortOutcome.error ? `abort-block failed: ${abortOutcome.error}` : `[${selectedTask.project}] ${abortOutcome.note}` };
  }

  // DR-0014: the worker proposed a decomposition (thread_split) instead of doing the task.
  // The signal rides on metadata.pendingControl (DR-0015 problem 1), read via detectSplitFromControl.
  // Decompose keep-parent (task becomes the join/acceptance node) and unclaim; the children flow
  // through the normal dispatch queue.
  const splitOutcome = await processSplitOutcome(
    { threadId: thread.id, taskId: selectedTask.id ?? null, project: selectedTask.project },
    {
      detect: detectSplitFromControl,
      // system:true — no agent lock in the dispatch path; defer if a foreign lock exists.
      decompose: (p, t, subs, tid, opts) => taskMutator.decompose(p, t, subs, tid, { ...opts, system: true }),
      unclaim: (tid) => taskMutator.unclaim(tid),
    },
  );
  if (splitOutcome.handled) {
    // Control intent consumed — clear it so a re-read never re-fires.
    await clearPendingControl(thread.id);
    const text = splitOutcome.error
      ? `${Icons.error} [${selectedTask.project}] ${selectedTask.text.substring(0, 80)} | [SPLIT] proposal invalid: ${splitOutcome.error} — task unclaimed`
      : `🌿 [${selectedTask.project}] ${selectedTask.text.substring(0, 80)} | ${splitOutcome.note}`;
    if (statusMsg) {
      const queue = getOutboundQueue();
      if (queue) { await durableUpdate(queue, adapter, statusMsg, { text }); }
      else { await adapter.updateMessage(statusMsg, { text }).catch(() => {}); }
    }
    if (splitOutcome.error) {
      return { success: false, skipped: false, note: `[SPLIT] invalid: ${splitOutcome.error}` };
    }
    return { success: true, skipped: false, note: `[${selectedTask.project}] ${splitOutcome.note}` };
  }

  // Rate-limit pause keeps the task claimed so a fresh dispatch cannot race the resumed thread.
  // Do not publish completion or finalize until the resumed thread truly terminates.
  if (threadResult.thread?.status === 'rate_limited') {
    if (statusMsg) {
      // Persist the live status message so the post-resume settle can refresh it.
      await threadStore.mutate(thread.id, (t) => { (t.metadata ??= {}).statusMsgRef = statusMsg; });
      const text = `${Icons.warning} [${selectedTask.project}] ${selectedTask.text.substring(0, 80)} | paused — rate limited, will auto-resume`;
      const queue = getOutboundQueue();
      if (queue) { await durableUpdate(queue, adapter, statusMsg, { text }); }
      else { await adapter.updateMessage(statusMsg, { text }).catch(() => {}); }
    }
    return { success: true, skipped: false, note: `Paused [${selectedTask.project}] — rate limited, will auto-resume` };
  }

  if (result?.rateLimited) {
    // Fallback: rate-limited but no active throttle, so the runner did not pause the thread.
    const { elapsedStr } = computeElapsed(startTime);
    await taskMutator.unclaim(selectedTask.id);
    if (statusMsg) {
      const text = `${Icons.warning} [${selectedTask.project}] ${selectedTask.text.substring(0, 80)} | ${buildSessionTag(sessionName, result?.sessionId)}Rate limited — all fallbacks exhausted (${elapsedStr})`;
      const queue = getOutboundQueue();
      if (queue) { await durableUpdate(queue, adapter, statusMsg, { text }); }
      else { await adapter.updateMessage(statusMsg, { text }); }
    }
    return { success: false, skipped: false, note: 'Rate limited — all fallbacks exhausted' };
  }
  await finalizeThreadSuccess(adapter, channel, statusMsg, {
    startTime, sessionName, result, threadResult, project: selectedTask.project, trigger: 'task-dispatch',
    label: selectedTask.text?.substring(0, 60) || null, sessionKind: 'scheduled' as 'scheduled' | 'local',
    sessionOrigin: 'thread',
    statusPrefix: `Done: [${selectedTask.project}] ${selectedTask.text.substring(0, 80)}`,
  });
  if (selectedTask.id) {
    dispatchFailureCounts.delete(selectedTask.id);
    ctx.bus!.publish({ type: 'task.completed', taskId: selectedTask.id });
  }
  return { success: true, skipped: false, note: `Completed [${selectedTask.project}] ${selectedTask.text.substring(0, 60)}` };
}

async function handleDispatchError(error: Error, selectedTask: Record<string, any> | null, channel: string): Promise<{ success: boolean; skipped: boolean; note: string }> {
  const adapter = ctx.adapter!;
  log.error(`Error: ${error.message}`);
  if (selectedTask) {
    try { await taskMutator.unclaim(selectedTask.id); } catch (e) { log.error(`Failed to unclaim task: ${(e as Error).message}`); }
  }
  const errChannel = channel;
  let blocked = false;
  let blockReason: string | null = null;
  if (selectedTask?.task_hash) {
    const taskHash: string = selectedTask.id;
    const prev = dispatchFailureCounts.get(taskHash) || { count: 0, lastError: '' };
    const next = { count: prev.count + 1, lastError: error.message };
    dispatchFailureCounts.set(taskHash, next);
    if (next.count >= DISPATCH_FAILURE_QUARANTINE_THRESHOLD) {
      blockReason = sanitizeBlockReason(`dispatch-failed-${next.count}x: ${error.message}`);
      try {
        await taskMutator.block(taskHash, blockReason);
        blocked = true;
        dispatchFailureCounts.delete(taskHash);
      } catch (e) {
        log.error(`Failed to auto-block task ${taskHash}: ${(e as Error).message}`);
      }
    }
  }
  try {
    const queue = getOutboundQueue();
    if (blocked && selectedTask) {
      const text = `${Icons.blocked} Auto-blocked after ${DISPATCH_FAILURE_QUARANTINE_THRESHOLD} consecutive dispatch failures. Reason recorded in TASKS.yaml. Task: [${selectedTask.project}] ${String(selectedTask.text).substring(0, 80)}. Last error: ${error.message}. Unblock with \`cortex-task unblock --task-id ${selectedTask.id}\`.`;
      const projDest = { type: 'project-report' as const, projectId: selectedTask.project || errChannel, trigger: 'task-dispatch', sessionId: '' };
      if (queue) { await durablePost(queue, adapter, projDest, { text }); }
      else { await adapter.postMessage(projDest, { text }); }
    } else {
      const text = `${Icons.error} Task dispatch error: ${error.message}`;
      const projDest = { type: 'project-report' as const, projectId: selectedTask?.project || errChannel, trigger: 'task-dispatch', sessionId: '' };
      if (queue) { await durablePost(queue, adapter, projDest, { text }); }
      else { await adapter.postMessage(projDest, { text }); }
    }
  } catch {}
  const noteSuffix = blocked ? ' (blocked)' : '';
  return { success: false, skipped: false, note: `Error: ${error.message}${noteSuffix}` };
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

// Self-register
register('task-dispatch', async (payload: unknown) => {
  const p = payload as { channel: string; scheduleTaskId: string; profileName: string };
  taskDispatchRunner(p);
});
