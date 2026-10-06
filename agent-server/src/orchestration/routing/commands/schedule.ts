import type { ActionContext, ActionElement, MessageRef, PlatformAdapter } from '@platform/index.js';
import type { CommandResult } from './command-context.js';
import type { CommandActionRouter } from '@orch/interactions/command-action-router.js';
import type { Scheduler, ScheduleTask } from '@domain/scheduling/scheduler.js';
import {
  isScheduleType, normalizeScheduleSpec, ScheduleSpecError,
  type ScheduleSpec, type ScheduleSpecInput, type ScheduleType,
} from '@domain/scheduling/schedule-spec.js';
import { formatDuration } from '@core/format-duration.js';
import { listProfiles, resolveProfile, getDefaultProfileName } from '@domain/agents/profile-manager.js';
import { channelToProjectId } from '@store/schedule-repo.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { MessageKey } from '../../../core/locales/en.js';

export type ScheduleCommandScheduler = Pick<Scheduler, 'list' | 'add' | 'pause' | 'resume' | 'remove'>;

const MAX_SCHEDULE_BUTTONS = 10;

function formatTimeUntilCompact(ms: number): string {
  if (ms <= 0) return t('cmd.schedule.now');
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatTaskLine(task: ScheduleTask, now: number): string {
  const id = `\`${task.id}\``;
  const profile = task.profile ? ` · ${task.profile}` : '';
  const paused = task.isPaused ? ` · *${t('cmd.schedule.paused')}*` : '';
  const nextMs = (task.nextRun || task.runAt || 0) - now;
  const next = task.isPaused ? '' : ` · ${t('cmd.schedule.nextLabel')}: ${formatTimeUntilCompact(nextMs)}`;
  const msg = task.message.length > 40 ? task.message.slice(0, 37) + '...' : task.message;
  return `${id} ${task.type}${profile}${paused}${next} · "${msg}"`;
}

function taskButton(task: ScheduleTask, index: number): ActionElement {
  if (task.type === 'once') {
    return { type: 'button', text: t('cmd.schedule.removeButton', { id: task.id }), actionId: `cmd:schedule:remove-${index}`, value: task.id, style: 'danger' };
  }
  const action = task.isPaused ? 'resume' : 'pause';
  const label = task.isPaused ? t('cmd.schedule.resumeButton', { id: task.id }) : t('cmd.schedule.pauseButton', { id: task.id });
  return { type: 'button', text: label, actionId: `cmd:schedule:${action}-${index}`, value: task.id };
}

function listText(tasks: ScheduleTask[]): string {
  if (tasks.length === 0) return t('cmd.schedule.none');
  const now = Date.now();
  return `${t('cmd.schedule.header', { n: tasks.length })}\n${tasks.map(task => `• ${formatTaskLine(task, now)}`).join('\n')}`;
}

function listResult(tasks: ScheduleTask[]): CommandResult {
  const text = listText(tasks);
  if (tasks.length === 0) return { text };
  const actions = tasks.slice(0, MAX_SCHEDULE_BUTTONS).map(taskButton);
  return { text, richBlocks: [{ type: 'section', text }], actions };
}

function registerButtonActions(scheduler: ScheduleCommandScheduler, router: CommandActionRouter): void {
  const refreshList = async (adapter: PlatformAdapter, messageRef: MessageRef) => {
    const tasks = await scheduler.list();
    const { text, actions } = listResult(tasks);
    const richBlocks = [{ type: 'section' as const, text }, ...(actions ? [{ type: 'actions' as const, elements: actions }] : [])];
    await adapter.updateMessage(messageRef, { text, richBlocks }).catch(() => {});
  };
  const buttonHandler = (run: (id: string) => Promise<unknown>) => async (ctx: ActionContext) => {
    const adapter = router.getAdapter();
    if (!adapter || !ctx.messageRef) return;
    try { await run(ctx.value); } catch { /* the refreshed list shows the real state */ }
    await refreshList(adapter, ctx.messageRef);
  };
  const handlers = {
    pause: buttonHandler((id) => scheduler.pause(id)),
    resume: buttonHandler((id) => scheduler.resume(id)),
    remove: buttonHandler((id) => scheduler.remove(id)),
  };
  const actions = Object.entries(handlers).flatMap(([name, handler]) =>
    Array.from({ length: MAX_SCHEDULE_BUTTONS }, (_, i) => ({ actionId: `${name}-${i}`, handler })));
  router.registerCommand('schedule', { actions });
}

// ── !schedule add / pause / resume / remove ─────────────────────────

interface SubContext { channel: string; scheduler: ScheduleCommandScheduler }
type SubHandler = (args: string[], ctx: SubContext) => Promise<CommandResult>;

const reply = (text: string): CommandResult => ({ text });
const FMT_OPTS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
const fmtTime = (ts: number): string => new Date(ts).toLocaleString('en-US', FMT_OPTS);
const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function scheduleHelp(): string {
  const profileNames = listProfiles().map(p => `\`${p.name}\``).join(', ');
  const keys: MessageKey[] = [
    'schedule.help.title', 'schedule.help.addInterval', 'schedule.help.addDaily', 'schedule.help.addWeekly',
    'schedule.help.addOnce', 'schedule.help.list', 'schedule.help.pause', 'schedule.help.resume', 'schedule.help.remove',
  ];
  return [...keys.map((key) => t(key)), t('schedule.help.availableProfiles', { profileNames })].join('\n');
}

function normalizeTaskId(id: string | undefined): string | undefined {
  const trimmed = id?.trim();
  return trimmed?.match(/^`([^`]+)`$/)?.[1] ?? trimmed;
}

const notFound = (id: string): string => `${Icons.error} ${t('schedule.taskNotFound', { id })}`;

function idCommand(usageKey: MessageKey, run: (id: string, scheduler: ScheduleCommandScheduler) => Promise<string>): SubHandler {
  return async ([rawId], { scheduler }) => {
    const id = normalizeTaskId(rawId);
    if (!id) return reply(t(usageKey));
    try {
      return reply(await run(id, scheduler));
    } catch (error) {
      return reply(`${Icons.error} ${(error as Error).message}`);
    }
  };
}

const handleRemove = idCommand('schedule.remove.usage', async (id, scheduler) =>
  (await scheduler.remove(id)) ? `${Icons.ok} ${t('schedule.remove.ok', { id })}` : notFound(id));

const handlePause = idCommand('schedule.pause.usage', async (id, scheduler) =>
  (await scheduler.pause(id)) ? `${Icons.paused} ${t('schedule.pause.ok', { id })}` : notFound(id));

const handleResume = idCommand('schedule.resume.usage', async (id, scheduler) => {
  const task = await scheduler.resume(id);
  if (!task) return notFound(id);
  const nextAt = task.nextRun ? t('schedule.resume.nextRun', { time: fmtTime(task.nextRun) }) : '';
  return `${Icons.resume} ${t('schedule.resume.ok', { id, nextAt })}`;
});

/** How many timing words follow `add <type>`, and which spec fields they fill. */
const TIMING_ARGS: Record<ScheduleType, [number, (words: string[]) => Partial<ScheduleSpecInput>]> = {
  interval: [1, ([interval]) => ({ interval })],
  daily: [1, ([time]) => ({ time })],
  weekly: [2, ([dayOfWeek, time]) => ({ dayOfWeek, time })],
  once: [1, ([delay]) => ({ delay })],
};

const ADD_USAGE: Record<ScheduleType, MessageKey> = {
  interval: 'schedule.add.intervalUsage',
  daily: 'schedule.add.dailyUsage',
  weekly: 'schedule.add.weeklyUsage',
  once: 'schedule.add.onceUsage',
};

const SPEC_ERROR_TEXT: Record<string, (value: string, type: ScheduleType) => string> = {
  interval: (duration) => t('schedule.invalidDuration', { duration }),
  delay: (duration) => t('schedule.invalidDuration', { duration }),
  time: (time, type) => t('schedule.invalidTime', { time, example: type === 'weekly' ? '21:00' : '09:00' }),
  dayOfWeek: (day) => t('schedule.invalidDay', { day }),
};

function specErrorText(error: ScheduleSpecError, type: ScheduleType): string {
  const text = SPEC_ERROR_TEXT[error.field];
  return text && error.value !== undefined ? text(String(error.value), type) : t(ADD_USAGE[type]);
}

/** `[--profile <name>] <message…>` → the profile to run under (validated) and the message words. */
function splitProfile(words: string[], type: ScheduleType): { profile: string; message: string } {
  if (words[0] !== '--profile') return { profile: getDefaultProfileName(), message: words.join(' ') };
  const profile = words[1];
  if (!profile) throw new Error(t(ADD_USAGE[type]));
  resolveProfile(profile);
  return { profile, message: words.slice(2).join(' ') };
}

const SCHEDULED_TEXT: { [K in ScheduleType]: (spec: Extract<ScheduleSpec, { type: K }>) => string } = {
  interval: (s) => t('schedule.add.scheduledInterval', { duration: formatDuration(s.intervalMs), message: s.message }),
  daily: (s) => t('schedule.add.scheduledDaily', { time: s.time, message: s.message }),
  weekly: (s) => t('schedule.add.scheduledWeekly', { day: WEEKDAY_LABELS[s.dayOfWeek], time: s.time, message: s.message }),
  once: (s) => t('schedule.add.scheduledOnce', { duration: formatDuration(s.delayMs), message: s.message }),
};

function scheduledText(spec: ScheduleSpec, task: ScheduleTask): string {
  const summary = (SCHEDULED_TEXT[spec.type] as (s: ScheduleSpec) => string)(spec);
  const profile = task.profile ? `\nprofile: *${task.profile}*` : '';
  const firstRun = task.type === 'once' ? task.runAt : task.nextRun;
  const label = task.type === 'once' ? 'runs at' : 'first run';
  const when = firstRun ? ` | ${label}: ${fmtTime(firstRun)}` : '';
  return `${Icons.ok} ${summary}\nid: \`${task.id}\`${profile}${when}`;
}

const handleAdd: SubHandler = async ([type, ...words], { channel, scheduler }) => {
  if (!type) return reply(scheduleHelp());
  if (!isScheduleType(type)) return reply(t('schedule.add.unknownType', { type }));
  const [arity, timing] = TIMING_ARGS[type];
  let spec: ScheduleSpec;
  try {
    const { profile, message } = splitProfile(words.slice(arity), type);
    spec = normalizeScheduleSpec({ type, ...timing(words.slice(0, arity)), message, profile, projectId: channelToProjectId(channel) });
  } catch (error) {
    return reply(error instanceof ScheduleSpecError ? specErrorText(error, type) : `${Icons.error} ${(error as Error).message}`);
  }
  return reply(scheduledText(spec, await scheduler.add(spec)));
};

const SUB_HANDLERS: Record<string, SubHandler> = {
  add: handleAdd,
  pause: handlePause,
  resume: handleResume,
  remove: handleRemove,
};

export function createScheduleHandler(scheduler: ScheduleCommandScheduler | null, router?: CommandActionRouter) {
  if (router && scheduler) registerButtonActions(scheduler, router);

  return async function handleScheduleCmd(
    channel: string, _adapter: PlatformAdapter, trimmedMessage: string,
  ): Promise<CommandResult> {
    const [, sub, ...args] = trimmedMessage.split(/\s+/);
    if (router && scheduler && (!sub || sub === 'list')) return listResult(await scheduler.list());
    const handler = scheduler ? SUB_HANDLERS[sub] : undefined;
    return handler ? handler(args, { channel, scheduler: scheduler! }) : reply(scheduleHelp());
  };
}
