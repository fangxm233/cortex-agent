import * as crypto from 'node:crypto';
import { requireJobCtx } from '../job-registry.js';
import { createLogger } from '@core/log.js';
import * as executionRegistry from '../../executions/registry.js';
import { sessionStore } from '@store/session-registry-repo.js';
import { conversationLedger } from '@store/conversation-ledger-repo.js';
import { applyChannelSelection, resolveBackendForChannel } from '../../agents/index.js';
import type { EngineSelection } from '../../agents/engine-selection.js';
import { projectStore } from '@domain/projects/index.js';
import { createDirectSession, type CreateDirectSessionDeps } from '@domain/sessions/session-lifecycle.js';
import { setSessionAsync } from '@domain/sessions/session.js';
import { isValidDispatchPrompt, hasRunningExecutionForSchedule } from '../run-guards.js';
import { configIsRateLimited } from '../../agents/provider-run-lifecycle.js';
import type { Destination } from '@platform/index.js';
import { t } from '@core/i18n.js';
import { publishSystemNotice } from '@domain/system/system-notice.js';

const log = createLogger('scheduled-task');

/** Fires between passing the guards and their turn being admitted. A run's execution record only
 *  exists once its turn starts, so without this a second fire in that window would not see it. */
const scheduledTaskActive = new Set<string>();

// --- Guards ---

function passScheduledGuards(schedKey: string, scheduleTaskId: string): boolean {
  const runningExecutions = executionRegistry.getRunningExecutions();
  if (scheduledTaskActive.has(schedKey) || hasRunningExecutionForSchedule(runningExecutions, scheduleTaskId)) {
    log.info(`Skipping — the previous run of ${schedKey} is still going`);
    return false;
  }
  return true;
}

// --- Public entry point (non-async fire-and-forget) ---

export interface RunScheduledTaskInput {
  message: string;
  projectId: string;
  scheduleTaskId: string;
  selection: EngineSelection;
}

/** Collaborators the run is opened with. Production uses the real stores; tests inject their own. */
export interface ScheduledRunDeps {
  createSession: (opts: Parameters<typeof createDirectSession>[1]) => ReturnType<typeof createDirectSession>;
  applySelection: typeof applyChannelSelection;
  newSessionId: () => string;
}

const sessionDeps: CreateDirectSessionDeps = {
  sessionStore,
  setChannelSession: setSessionAsync,
  initConversation: async (channel, a) => { await conversationLedger.initConversation(channel, a); },
  resolveBackend: resolveBackendForChannel,
};

const defaultDeps: ScheduledRunDeps = {
  createSession: (opts) => createDirectSession(sessionDeps, opts),
  applySelection: applyChannelSelection,
  newSessionId: () => crypto.randomUUID(),
};

/** Fire one schedule. Fire-and-forget: the scheduler's timer never waits on the run. */
export function runScheduledTask(input: RunScheduledTaskInput, deps: ScheduledRunDeps = defaultDeps): void {
  void fireScheduledTask(input, deps);
}

/**
 * Fire one schedule and resolve once its turn is admitted (or the fire was skipped). A fire opens a
 * session of its own — an ordinary direct session on its own `web:<sessionId>` channel, recorded as
 * the schedule's run — and delivers the schedule's prompt as its first turn. Everything after that
 * (the run itself, a rate-limit pause and its resume, a reply adopting the run) is the session's.
 */
export async function fireScheduledTask(
  input: RunScheduledTaskInput,
  deps: ScheduledRunDeps = defaultDeps,
): Promise<void> {
  const { projectId, scheduleTaskId } = input;
  const schedKey = `sched:${scheduleTaskId || projectId}`;
  if (!passScheduledGuards(schedKey, scheduleTaskId)) return;
  if (!(await canOpenScheduledRun(input))) return;
  // Re-check after the async guard: another fire may already have reserved this schedule.
  if (!passScheduledGuards(schedKey, scheduleTaskId)) return;
  scheduledTaskActive.add(schedKey);
  try {
    await openScheduledRun(input, deps);
  } catch (error) {
    // Nothing ran, so the notice is the only trace this fire leaves.
    log.error(`Scheduled task ${scheduleTaskId} setup failed:`, (error as Error).message);
    await notifySkippedSchedule(projectId, t('notice.schedule.error', { error: (error as Error).message }));
  } finally {
    scheduledTaskActive.delete(schedKey);
  }
}

async function canOpenScheduledRun({ message, projectId, scheduleTaskId, selection }: RunScheduledTaskInput): Promise<boolean> {
  if (!isValidDispatchPrompt(message)) {
    log.warn(`Guard dropped null/empty prompt for schedule ${scheduleTaskId} (project=${projectId}, model=${selection.model}): "${message?.substring(0, 60) || String(message)}"`);
    return false;
  }
  if (!configIsRateLimited(selection)) return true;
  log.info(`Skipping schedule ${scheduleTaskId} — selection ${selection.backend}/${selection.model} is rate-limited`);
  await notifySkippedSchedule(projectId, t('notice.schedule.rateLimited', { id: scheduleTaskId, message }));
  return false;
}

async function openScheduledRun(
  { message, projectId, scheduleTaskId, selection }: RunScheduledTaskInput,
  deps: ScheduledRunDeps,
): Promise<void> {
  const deliver = requireJobCtx('deliverScheduledTurn');
  const sessionId = deps.newSessionId();
  const channel = `web:${sessionId}`;

  // Apply the complete stored selection before creating the session, without changing the seed
  // for the user's next conversation.
  const applied = await deps.applySelection({ channel, ...selection, seedDefault: false });
  if (!applied.ok) throw new Error(`cannot run on model "${selection.model}": ${applied.reason}`);

  const created = await deps.createSession({
    projectId: projectStore.exists(projectId)
      ? projectId
      : projectStore.resolveFromMessage(message)?.id ?? 'general',
    sessionId,
    selection,
    scheduleId: scheduleTaskId || null,
    label: message.substring(0, 60) || null,
  });
  log.info(`Schedule ${scheduleTaskId} opened session ${created.sessionId} (${created.sessionId})`);
  await deliver({ channel: created.channel, text: message });
}

async function notifySkippedSchedule(projectId: string, text: string): Promise<void> {
  publishSystemNotice({ text, level: 'warning' });
  const destination: Destination = { type: 'project-report', projectId, trigger: 'scheduled', sessionId: '' };
  try {
    await requireJobCtx('notify')(destination, text);
  } catch { /* best-effort */ }
}
