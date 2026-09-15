import { register, ctx, requireJobCtx } from '../job-registry.js';
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
import { allConfigsRateLimited } from '../../runs/fallback.js';
import { createThread } from '../../threads/index.js';
import { registerThreadSession } from './register-thread-session.js';
import { planScheduledDispatch, type DispatchPlan } from './target-dispatch.js';
import type { Destination } from '@platform/index.js';
import type { ScheduleTarget, ScheduleTask } from '@store/schedule-repo.js';
// Type-only, so `domain` still never depends on `orchestration` at runtime: the run itself
// arrives through `ctx.runThreadOnSurface`, injected by app.ts.
import type { TaskVerdict, ThreadRunOutcome, ThreadRunSurfaceInput } from '@orch/thread-run/index.js';

/** The precise shape of `ctx.runThreadOnSurface` — see the type's doc in job-registry for why it
 *  is re-declared here rather than named there. */
type RunOnSurface = (input: ThreadRunSurfaceInput) => Promise<ThreadRunOutcome>;
type RunInput = Parameters<RunOnSurface>[0];

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
  runScheduledTaskAsync({ normalizedMessage, message, projectId, scheduleTaskId, profileName, target, fallback })
    .catch((e) => log.error(`Scheduled task ${scheduleTaskId} failed:`, (e as Error).message))
    .finally(() => {
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
  // Build the project-report destination for all outbound messages from this scheduled run.
  const projectReportDest: Destination = { type: 'project-report', projectId, trigger: 'scheduled', sessionId: '' };

  let input: RunInput;
  try {
    const plan = await resolveDispatchPlan(projectId, target, fallback);
    const effectiveProfile = profileName || getActiveProfile(projectId) || 'default';
    const sessionName = await sessionStore.generateSessionName();

    // Skip plans short-circuit before the run starts, so they don't pollute the project channel
    // with a processing line (which ThreadRun would otherwise post).
    if (plan.kind === 'skip') {
      log.info(`Skipping schedule ${scheduleTaskId}: ${plan.reason}`);
      const notify = requireJobCtx('notify');
      try { await notify(projectReportDest, `${Icons.superseded} Scheduled task skipped — ${plan.reason}`); } catch {}
      return;
    }

    input = buildRunInput({
      plan, normalizedMessage, message, scheduleTaskId, effectiveProfile, startTime,
      sessionName, projectReportDest, projectId,
    });
  } catch (error) {
    // Nothing ran, so there is no status line to seal — only the notice. (Before T2.2 a plan
    // failure here was an unhandled rejection and said nothing at all.)
    const notify = requireJobCtx('notify');
    log.error('Scheduled task setup failed:', (error as Error).message);
    try { await notify(projectReportDest, `Scheduled task error: ${(error as Error).message}`); } catch {}
    return;
  }

  await (requireJobCtx('runThreadOnSurface') as RunOnSurface)(input);
}

// --- Plan execution ---

interface DispatchExecuteInput {
  plan: Exclude<DispatchPlan, { kind: 'skip' }>;
  normalizedMessage: string;
  message: string;
  scheduleTaskId: string;
  effectiveProfile: string;
  startTime: number;
  sessionName: string;
  projectReportDest: Destination;
  projectId: string;
}

/** Turn a resolved plan into the one `ThreadRun` call this job makes. `continue-thread` re-enters
 *  an existing thread; `fresh` is the original scheduled-task semantics (scheduler template, fresh
 *  session). Everything the run then draws belongs to render-task's `scheduled` flavour. */
function buildRunInput({ plan, normalizedMessage, message, scheduleTaskId, effectiveProfile, startTime, sessionName, projectReportDest, projectId }: DispatchExecuteInput): RunInput {
  const project = projectStore.resolveFromMessage(message)?.id ?? 'general';
  const threadId = plan.kind === 'continue-thread'
    ? plan.threadId
    : createThread(plan.channel, {
      templateName: 'scheduler',
      userMessage: normalizedMessage,
      userMessageTs: `sched_${Date.now()}`,
      projectId: project,
      metadata: { scheduleTaskId, trigger: 'scheduled', profileOverride: effectiveProfile },
    }).id;

  return {
    threadId,
    mode: plan.kind === 'continue-thread'
      ? { kind: 'continue', userMessage: normalizedMessage }
      : { kind: 'start' },
    channel: projectId,
    destination: projectReportDest,
    threadAnchorId: null,
    // A reply under a scheduled run's status line stays a conversation message, as it always has.
    claimPlatformThread: false,
    statusMessage: null,
    render: {
      kind: 'task', flavour: 'scheduled', project: projectId, taskText: null,
      sessionName, profileName: effectiveProfile,
    },
    interactive: true,
    startTime,
    settle: null,
    decide: (outcome) => decideScheduled(outcome, {
      projectId, sessionName, label: message?.substring(0, 60) || null,
      scheduleId: scheduleTaskId || null,
    }),
  };
}

/** What the finished run means for the SCHEDULE. The only durable effect is registering the
 *  session (the registration half of the old shared finalize helper) — a paused or rate-limited run
 *  registers nothing, exactly as before. */
async function decideScheduled(outcome: ThreadRunOutcome, c: {
  projectId: string; sessionName: string; label: string | null; scheduleId: string | null;
}): Promise<TaskVerdict> {
  if (outcome.error) return { kind: 'error', message: outcome.error.message };
  // Rate-limit pause: the runner already recorded the thread for auto-resume and left it in
  // 'rate_limited'. Don't treat it as a failure — just reflect the paused state.
  if (outcome.verdict === 'rate_limited') return { kind: 'paused' };
  // Fallback: rate-limited but no active throttle, so the runner did not pause the thread.
  if (outcome.verdict === 'rate_limited_exhausted') return { kind: 'exhausted' };

  await registerThreadSession(c.projectId, {
    sessionName: c.sessionName,
    result: (outcome.result?.lastAgentResult ?? null) as any,
    threadResult: (outcome.result ?? {}) as Record<string, any>,
    project: c.projectId, label: c.label,
    sessionKind: 'scheduled', sessionOrigin: 'scheduled',
    scheduleId: c.scheduleId,
  });
  return { kind: 'done' };
}

// Self-register
register('scheduled-task', async (payload: unknown) => {
  const p = payload as RunScheduledTaskInput;
  runScheduledTask(p);
});
