// input:  PlatformAdapter, thread-runner, scheduler domain types
// output: runScheduledTask job runner — registers as 'scheduled-task'
// pos:    scheduled task execution (scheduled-task dispatchType), RunnerFn payload
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { register, ctx } from '../job-registry.js';
import { createLogger } from '@core/log.js';
import { Icons } from '../../../core/icons.js';
import * as executionRegistry from '../../executions/registry.js';

const log = createLogger('scheduled-task');
import * as pendingTaskTracker from '../../tasks/pending-tracker.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { threadStore } from '@store/thread-repo.js';
import { getActiveProfile } from '../../agents/index.js';
import { projectStore } from '@domain/projects/index.js';
import { normalizeSkillCommandPrefix } from '../../memory/skill-scanner.js';
import { isValidDispatchPrompt, hasRunningExecutionForSchedule } from '../../tasks/dispatcher.js';
import { allConfigsRateLimited } from '../../agents/facade.js';
import { createThread } from '../../threads/index.js';
import { runThread as runThreadExec, continueThread } from '../../threads/runner.js';
import { buildUserProcessingMessage, computeElapsed, buildSessionTag } from '@core/status-format.js';
import { finalizeThreadSuccess, buildProgressUpdater } from './_shared.js';
import { planScheduledDispatch, type DispatchPlan } from './target-dispatch.js';
import type { PlatformAdapter, MessageRef, Destination } from '@platform/index.js';
import type { ScheduleTarget, ScheduleTask } from '@store/schedule-repo.js';
import { getOutboundQueue, durableUpdate, durablePost } from '@store/outbound-queue.js';

// Module-level state
const scheduledTaskActive = new Map<string, boolean>();

// --- Guards ---

function passScheduledGuards(schedKey: string, scheduleTaskId: string): boolean {
  const runningExecutions = executionRegistry.getRunningExecutions();
  if (scheduledTaskActive.has(schedKey) || hasRunningExecutionForSchedule(runningExecutions, scheduleTaskId)) {
    log.info(`Skipping — local agent still running for ${schedKey}`);
    return false;
  }
  const pending = pendingTaskTracker.getPendingTasksForSchedule(scheduleTaskId);
  if (pending.length > 0) {
    log.info(`Skipping — ${pending.length} pending task(s): ${pending.map(t => `${t.machine}:${t.taskId}`).join(', ')}`);
    return false;
  }
  return true;
}

// --- Public entry point (non-async fire-and-forget) ---

interface RunScheduledTaskInput {
  message: string;
  projectId: string;
  scheduleTaskId: string;
  profileName: string;
  target?: ScheduleTarget;
  fallback?: ScheduleTask['fallback'];
}

export function runScheduledTask({ message, projectId, scheduleTaskId, profileName, target, fallback }: RunScheduledTaskInput): void {
  const schedKey = `sched:${scheduleTaskId || projectId}`;
  if (!passScheduledGuards(schedKey, scheduleTaskId)) return;

  const normalizedMessage = normalizeSkillCommandPrefix(message);
  if (normalizedMessage !== message) {
    log.info('Auto-prefixed skill command:', normalizedMessage.substring(0, 80));
  }

  if (!isValidDispatchPrompt(normalizedMessage)) {
    log.warn(`Guard dropped null/empty prompt for schedule ${scheduleTaskId} (project=${projectId}, profile=${profileName}): "${message?.substring(0, 60) || String(message)}"`);
    return;
  }

  if (allConfigsRateLimited(profileName)) {
    log.info(`Skipping schedule ${scheduleTaskId} — all configs rate-limited for profile ${profileName}`);
    return;
  }

  scheduledTaskActive.set(schedKey, true);
  ctx.bus!.publish({ type: 'llm.active-count-delta', delta: 1 });
  runScheduledTaskAsync({ normalizedMessage, message, projectId, scheduleTaskId, profileName, target, fallback }).finally(() => {
    scheduledTaskActive.delete(schedKey);
    ctx.bus!.publish({ type: 'llm.active-count-delta', delta: -1 });
  });
}

// --- Plan resolution ---

async function resolveDispatchPlan(projectId: string, target: ScheduleTarget | undefined, fallback: ScheduleTask['fallback']): Promise<DispatchPlan> {
  const plan = await planScheduledDispatch({
    target,
    fallback,
    fallbackChannel: projectId,
    lookups: {
      getThread: (id) => threadStore.get(id),
    },
  });
  return plan;
}

// --- Async implementation ---

async function runScheduledTaskAsync({ normalizedMessage, message, projectId, scheduleTaskId, profileName, target, fallback }: RunScheduledTaskInput & { normalizedMessage: string }): Promise<void> {
  const startTime = Date.now();
  const plan = await resolveDispatchPlan(projectId, target, fallback);

  // Build the project-report destination for all outbound messages from this scheduled run.
  const projectReportDest: Destination = { type: 'project-report', projectId, trigger: 'scheduled', sessionId: '' };

  const effectiveProfile = profileName || getActiveProfile(projectId) || 'default';
  const sessionName = await sessionStore.generateSessionName();
  const adapter = ctx.adapter!;

  // Skip plans short-circuit before posting the processing status, so they don't pollute Slack.
  if (plan.kind === 'skip') {
    log.info(`Skipping schedule ${scheduleTaskId}: ${plan.reason}`);
    try { await adapter.postMessage(projectReportDest, { text: `${Icons.superseded} Scheduled task skipped — ${plan.reason}` }); } catch {}
    return;
  }

  let statusMsg: MessageRef | null = null;
  try {
    statusMsg = await adapter.postMessage(projectReportDest, { text: buildUserProcessingMessage({ startTime, profileName: effectiveProfile, sessionName }) });
  } catch (e) {
    log.error('Failed to post status message:', (e as Error).message);
  }

  try {
    const threadResult = await dispatchByPlan({ plan, normalizedMessage, message, scheduleTaskId, effectiveProfile, statusMsg, startTime, sessionName, projectReportDest, projectId });
    const result = threadResult.lastAgentResult as any;

    // Rate-limit pause: the runner already recorded the thread for auto-resume and left it in
    // 'rate_limited'. Don't treat it as a failure — just reflect the paused state.
    if (threadResult.thread?.status === 'rate_limited') {
      const { elapsedStr } = computeElapsed(startTime);
      if (statusMsg) {
        const text = `${Icons.warning} ${buildSessionTag(sessionName, result?.sessionId)}Paused — rate limited, will auto-resume (${elapsedStr})`;
        const queue = getOutboundQueue();
        if (queue) { await durableUpdate(queue, adapter, statusMsg, { text }); }
        else { await adapter.updateMessage(statusMsg, { text }); }
      }
    } else if (result?.rateLimited) {
      // Fallback: rate-limited but no active throttle, so the runner did not pause the thread.
      const { elapsedStr } = computeElapsed(startTime);
      if (statusMsg) {
        const text = `${Icons.warning} ${buildSessionTag(sessionName, result?.sessionId)}Rate limited — all fallbacks exhausted (${elapsedStr})`;
        const queue = getOutboundQueue();
        if (queue) { await durableUpdate(queue, adapter, statusMsg, { text }); }
        else { await adapter.updateMessage(statusMsg, { text }); }
      }
    } else {
      await finalizeThreadSuccess(adapter, projectId, statusMsg, {
        startTime, sessionName, result, threadResult, project: projectId, trigger: 'scheduled',
        label: message?.substring(0, 60) || null, sessionKind: 'scheduled', sessionOrigin: 'scheduled', statusPrefix: 'Done',
      });
    }
  } catch (error) {
    const { elapsedStr } = computeElapsed(startTime);
    const queue = getOutboundQueue();
    if (statusMsg) {
      const text = `${Icons.error} ${buildSessionTag(sessionName, null)}Error (${elapsedStr})`;
      if (queue) { await durableUpdate(queue, adapter, statusMsg, { text }); }
      else { await adapter.updateMessage(statusMsg, { text }); }
    }
    try {
      if (queue) { await durablePost(queue, adapter, projectReportDest, { text: `Scheduled task error: ${(error as Error).message}` }); }
      else { await adapter.postMessage(projectReportDest, { text: `Scheduled task error: ${(error as Error).message}` }); }
    } catch {}
  }
}

// --- Plan execution ---

interface DispatchExecuteInput {
  plan: Exclude<DispatchPlan, { kind: 'skip' }>;
  normalizedMessage: string;
  message: string;
  scheduleTaskId: string;
  effectiveProfile: string;
  statusMsg: MessageRef | null;
  startTime: number;
  sessionName: string;
  projectReportDest: Destination;
  projectId: string;
}

function dispatchByPlan({ plan, normalizedMessage, message, scheduleTaskId, effectiveProfile, statusMsg, startTime, sessionName, projectReportDest, projectId }: DispatchExecuteInput) {
  const project = projectStore.resolveFromMessage(message)?.id ?? 'general';
  const onProgress = statusMsg ? buildProgressUpdater(ctx.adapter!, statusMsg, startTime, effectiveProfile, sessionName) : undefined;
  const icb = ctx.buildInteractiveCallbacks?.(projectId, null);
  const baseRunOpts = {
    adapter: ctx.adapter!, channel: projectId, threadAnchorId: statusMsg?.messageId || null, statusMsg, startTime, onProgress,
    destination: projectReportDest,
    onToolUse: icb?.onToolUse ?? null, onPlanWritten: icb?.onPlanWritten ?? null, onAskUserQuestion: icb?.onAskUserQuestion ?? null,
  };

  if (plan.kind === 'continue-thread') {
    return continueThread(plan.threadId, normalizedMessage, { ...baseRunOpts });
  }

  // plan.kind === 'fresh' — original scheduled-task semantics: scheduler template, fresh session.
  const thread = createThread(plan.channel, {
    templateName: 'scheduler',
    userMessage: normalizedMessage,
    userMessageTs: `sched_${Date.now()}`,
    projectId: project,
    metadata: { scheduleTaskId, trigger: 'scheduled', profileOverride: effectiveProfile },
  });
  return runThreadExec(thread.id, { ...baseRunOpts });
}

// Self-register
register('scheduled-task', async (payload: unknown) => {
  const p = payload as RunScheduledTaskInput;
  runScheduledTask(p);
});
