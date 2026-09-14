import type { PlatformAdapter } from '@platform/adapter.js';
import type { Destination } from '@platform/types.js';
import { Icons } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { formatDuration, formatTimeUntil, parseDuration } from './scheduler.js';
import type { Scheduler, ScheduleTask } from './scheduler.js';
import { channelToProjectId } from '@store/schedule-repo.js';
import { listProfiles, resolveProfile, getDefaultProfileName } from '../agents/profile-manager.js';

/** Convert a raw channel string to a Destination for postMessage calls. */
function toDest(channel: string): Destination {
  return { type: 'interactive-reply', conduit: channel };
}

function scheduleHelp(): string {
  const profileNames = listProfiles().map(p => `\`${p.name}\``).join(', ');
  return [
    t('schedule.help.title'),
    t('schedule.help.addInterval'),
    t('schedule.help.addDaily'),
    t('schedule.help.addWeekly'),
    t('schedule.help.addOnce'),
    t('schedule.help.list'),
    t('schedule.help.pause'),
    t('schedule.help.resume'),
    t('schedule.help.remove'),
    t('schedule.help.availableProfiles', { profileNames }),
  ].join('\n');
}

const DAY_MAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

const FMT_OPTS: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
const fmtTime = (ts: number): string => new Date(ts).toLocaleString('en-US', FMT_OPTS);

async function handleList(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const tasks = await scheduler.list();
  if (tasks.length === 0) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.list.empty') });
    return;
  }
  const now = Date.now();
  const lines = tasks.map((task) => formatTaskLine(task, now));
  await adapter.postMessage(toDest(channel), { text: t('schedule.list.header', { count: tasks.length, lines: lines.join('\n') }) });
}

function formatTaskLine(t: ScheduleTask, now: number): string {
  const id = `\`${t.id}\``;
  const profile = ` | profile: *${t.profile || 'plan'}*`;
  const paused = t.isPaused ? ` | status: *paused*${t.pausedBy === 'rate-limit' ? ' (rate-limit)' : ''}` : '';
  if (t.type === 'interval') {
    const nextAt = t.nextRun ? ` (${fmtTime(t.nextRun)})` : '';
    const nextText = t.isPaused ? 'paused' : `${formatTimeUntil((t.nextRun || 0) - now)}${nextAt}`;
    return `• ${id} every *${formatDuration(t.intervalMs!)}*${profile}${paused} | next: ${nextText} | "${t.message}"`;
  }
  if (t.type === 'daily') {
    const nextAt = t.nextRun ? ` (${fmtTime(t.nextRun)})` : '';
    const nextText = t.isPaused ? 'paused' : `${formatTimeUntil((t.nextRun || 0) - now)}${nextAt}`;
    return `• ${id} daily *${t.time}*${profile}${paused} | next: ${nextText} | "${t.message}"`;
  }
  if (t.type === 'weekly') {
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const nextAt = t.nextRun ? ` (${fmtTime(t.nextRun)})` : '';
    const nextText = t.isPaused ? 'paused' : `${formatTimeUntil((t.nextRun || 0) - now)}${nextAt}`;
    return `• ${id} weekly *${dayNames[t.dayOfWeek!]} ${t.time}*${profile}${paused} | next: ${nextText} | "${t.message}"`;
  }
  if (t.type === 'once') {
    const nextAt = t.runAt ? ` (${fmtTime(t.runAt)})` : '';
    return `• ${id} once${profile} | runs: ${formatTimeUntil(t.runAt! - now)}${nextAt} | "${t.message}"`;
  }
  return `• ${id} ${t.type}${profile}${paused} | "${t.message}"`;
}

function normalizeTaskId(id: string | undefined): string | undefined {
  if (!id) return id;
  const trimmed = id.trim();
  const wrapped = trimmed.match(/^`([^`]+)`$/);
  return wrapped ? wrapped[1] : trimmed;
}

async function handleRemove(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const rawId = parts[2];
  const id = normalizeTaskId(rawId);
  if (!id) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.remove.usage') });
    return;
  }
  const removed = await scheduler.remove(id);
  await adapter.postMessage(toDest(channel), {
    text: removed ? `${Icons.ok} ${t('schedule.remove.ok', { id })}` : `${Icons.error} ${t('schedule.taskNotFound', { id })}`,
  });
}

async function handlePause(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const rawId = parts[2];
  const id = normalizeTaskId(rawId);
  if (!id) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.pause.usage') });
    return;
  }
  try {
    const task = await scheduler.pause(id);
    if (!task) {
      await adapter.postMessage(toDest(channel), { text: `${Icons.error} ${t('schedule.taskNotFound', { id })}` });
      return;
    }
    await adapter.postMessage(toDest(channel), { text: `${Icons.paused} ${t('schedule.pause.ok', { id })}` });
  } catch (error) {
    await adapter.postMessage(toDest(channel), { text: `${Icons.error} ${(error as Error).message}` });
  }
}

async function handleResume(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const rawId = parts[2];
  const id = normalizeTaskId(rawId);
  if (!id) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.resume.usage') });
    return;
  }
  try {
    const task = await scheduler.resume(id);
    if (!task) {
      await adapter.postMessage(toDest(channel), { text: `${Icons.error} ${t('schedule.taskNotFound', { id })}` });
      return;
    }
    const nextAt = task.nextRun ? t('schedule.resume.nextRun', { time: fmtTime(task.nextRun) }) : '';
    await adapter.postMessage(toDest(channel), { text: `${Icons.resume} ${t('schedule.resume.ok', { id, nextAt })}` });
  } catch (error) {
    await adapter.postMessage(toDest(channel), { text: `${Icons.error} ${(error as Error).message}` });
  }
}

function parseProfileArgs(args: string[], usage: string): { profileName: string; rest: string[] } {
  if (args.length >= 1 && args[0] !== '--profile') {
    return { profileName: getDefaultProfileName(), rest: args };
  }
  if (args[0] !== '--profile') {
    return { profileName: getDefaultProfileName(), rest: args };
  }
  const profileName = args[1];
  if (!profileName) throw new Error(t('schedule.profileUsage', { usage }));
  try {
    resolveProfile(profileName);
  } catch (error) {
    throw new Error((error as Error).message);
  }
  return { profileName, rest: args.slice(2) };
}

function buildScheduledConfirmation(prefix: string, task: ScheduleTask, timestampLabel: string): string {
  const profileText = task.profile ? `\nprofile: *${task.profile}*` : '';
  return `${prefix}\nid: \`${task.id}\`${profileText}${timestampLabel}`;
}

async function handleAddInterval(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const durationStr = parts[3];
  let parsed: { profileName: string; rest: string[] };
  try {
    parsed = parseProfileArgs(parts.slice(4), '`!schedule add interval <duration> [--profile <name>] <message>`');
  } catch (error) {
    await adapter.postMessage(toDest(channel), { text: `${Icons.error} ${(error as Error).message}` });
    return;
  }
  const msg = parsed.rest.join(' ');
  const ms = parseDuration(durationStr);
  if (!ms) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.invalidDuration', { duration: durationStr }) });
    return;
  }
  if (!msg) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.add.intervalUsage') });
    return;
  }
  const resolvedProjectId = channelToProjectId(channel) ?? 'general';
  const task = await scheduler.add('interval', { intervalMs: ms, message: msg, projectId: resolvedProjectId, profile: parsed.profileName });
  const nextAt = task.nextRun ? ` | first run: ${fmtTime(task.nextRun)}` : '';
  await adapter.postMessage(toDest(channel), { text: buildScheduledConfirmation(`${Icons.ok} ${t('schedule.add.scheduledInterval', { duration: formatDuration(ms), message: msg })}`, task, nextAt) });
}

async function handleAddDaily(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const time = parts[3];
  let parsed: { profileName: string; rest: string[] };
  try {
    parsed = parseProfileArgs(parts.slice(4), '`!schedule add daily <HH:MM> [--profile <name>] <message>`');
  } catch (error) {
    await adapter.postMessage(toDest(channel), { text: `${Icons.error} ${(error as Error).message}` });
    return;
  }
  const msg = parsed.rest.join(' ');
  if (!/^\d{2}:\d{2}$/.test(time)) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.invalidTime', { time, example: '09:00' }) });
    return;
  }
  if (!msg) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.add.dailyUsage') });
    return;
  }
  const resolvedProjectId = channelToProjectId(channel) ?? 'general';
  const task = await scheduler.add('daily', { time, message: msg, projectId: resolvedProjectId, profile: parsed.profileName });
  const nextAt = task.nextRun ? ` | first run: ${fmtTime(task.nextRun)}` : '';
  await adapter.postMessage(toDest(channel), { text: buildScheduledConfirmation(`${Icons.ok} ${t('schedule.add.scheduledDaily', { time, message: msg })}`, task, nextAt) });
}

async function handleAddWeekly(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const dayStr = (parts[3] || '').toLowerCase();
  const time = parts[4];
  let parsed: { profileName: string; rest: string[] };
  try {
    parsed = parseProfileArgs(parts.slice(5), '`!schedule add weekly <day> <HH:MM> [--profile <name>] <message>`');
  } catch (error) {
    await adapter.postMessage(toDest(channel), { text: `${Icons.error} ${(error as Error).message}` });
    return;
  }
  const msg = parsed.rest.join(' ');
  const dayOfWeek = DAY_MAP[dayStr];
  if (dayOfWeek == null) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.invalidDay', { day: parts[3] }) });
    return;
  }
  if (!/^\d{2}:\d{2}$/.test(time)) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.invalidTime', { time, example: '21:00' }) });
    return;
  }
  if (!msg) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.add.weeklyUsage') });
    return;
  }
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const resolvedProjectId = channelToProjectId(channel) ?? 'general';
  const task = await scheduler.add('weekly', { dayOfWeek, time, message: msg, projectId: resolvedProjectId, profile: parsed.profileName });
  const nextAt = task.nextRun ? ` | first run: ${fmtTime(task.nextRun)}` : '';
  await adapter.postMessage(toDest(channel), { text: buildScheduledConfirmation(`${Icons.ok} ${t('schedule.add.scheduledWeekly', { day: dayNames[dayOfWeek], time, message: msg })}`, task, nextAt) });
}

async function handleAddOnce(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const durationStr = parts[3];
  let parsed: { profileName: string; rest: string[] };
  try {
    parsed = parseProfileArgs(parts.slice(4), '`!schedule add once <duration> [--profile <name>] <message>`');
  } catch (error) {
    await adapter.postMessage(toDest(channel), { text: `${Icons.error} ${(error as Error).message}` });
    return;
  }
  const msg = parsed.rest.join(' ');
  const ms = parseDuration(durationStr);
  if (!ms) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.invalidDuration', { duration: durationStr }) });
    return;
  }
  if (!msg) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.add.onceUsage') });
    return;
  }
  const resolvedProjectId = channelToProjectId(channel) ?? 'general';
  const task = await scheduler.add('once', { delay: ms, message: msg, projectId: resolvedProjectId, profile: parsed.profileName });
  const runAt = task.runAt ? ` | runs at: ${fmtTime(task.runAt)}` : '';
  await adapter.postMessage(toDest(channel), { text: buildScheduledConfirmation(`${Icons.ok} ${t('schedule.add.scheduledOnce', { duration: formatDuration(ms), message: msg })}`, task, runAt) });
}

type SubHandler = (parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler) => Promise<void>;

const ADD_TYPE_HANDLERS: Record<string, SubHandler> = {
  interval: handleAddInterval,
  daily: handleAddDaily,
  weekly: handleAddWeekly,
  once: handleAddOnce,
};

async function handleAdd(parts: string[], channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const type = parts[2];
  const handler = ADD_TYPE_HANDLERS[type];
  if (handler) return handler(parts, channel, adapter, scheduler);
  if (type) {
    await adapter.postMessage(toDest(channel), { text: t('schedule.add.unknownType', { type }) });
    return;
  }
  await adapter.postMessage(toDest(channel), { text: scheduleHelp() });
}

const SUB_HANDLERS: Record<string, SubHandler> = {
  list: handleList,
  pause: handlePause,
  resume: handleResume,
  remove: handleRemove,
  add: handleAdd,
};

async function handleScheduleCommand(text: string, channel: string, adapter: PlatformAdapter, scheduler: Scheduler): Promise<void> {
  const parts = text.split(/\s+/);
  const sub = parts[1];
  const handler = SUB_HANDLERS[sub];
  if (handler) return handler(parts, channel, adapter, scheduler);
  await adapter.postMessage(toDest(channel), { text: scheduleHelp() });
}

export { handleScheduleCommand };
