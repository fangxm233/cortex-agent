import type { ScheduleTask } from '@store/schedule-repo.js';
import { isValidDispatchPrompt } from './run-guards.js';

export const SCHEDULE_TYPES = ['interval', 'daily', 'weekly', 'once'] as const;
export type ScheduleType = typeof SCHEDULE_TYPES[number];

/** Lower-case day abbreviations → Date#getDay() index. */
export const DAY_MAP: Readonly<Record<string, number>> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export type ScheduleTiming =
  | { type: 'interval'; intervalMs: number }
  | { type: 'daily'; time: string }
  | { type: 'weekly'; dayOfWeek: number; time: string }
  | { type: 'once'; delayMs: number };

/** A validated request to create a schedule. Built only by normalizeScheduleSpec. */
export type ScheduleSpec = ScheduleTiming & {
  message: string;
  projectId: string;
  profile: string | null;
  preCheck?: string;
};

/** Schedule fields as an entry point parsed them from its own syntax. Durations are a unit string
 *  ("30s", "5m", "2h", "1d") or a number of milliseconds; dayOfWeek is sun..sat or 0-6. */
export interface ScheduleSpecInput {
  type: string | undefined;
  message: string | null | undefined;
  projectId?: string | null;
  profile?: string | null;
  preCheck?: string | null;
  interval?: string | number;
  time?: string;
  dayOfWeek?: string | number;
  delay?: string | number;
}

/** Fields an existing schedule accepts; the type is immutable. */
export interface SchedulePatch {
  message?: string;
  projectId?: string;
  profile?: string | null;
  preCheck?: string;
  dispatchType?: string;
  intervalMs?: number;
  time?: string;
  dayOfWeek?: number;
  runAt?: number;
}

export class ScheduleSpecError extends Error {
  constructor(readonly field: string, message: string, readonly value?: unknown) {
    super(message);
    this.name = 'ScheduleSpecError';
  }
}

const DURATION_UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "30s" | "5m" | "2h" | "1d" → milliseconds, or null when the string is not a duration. */
export function parseDuration(str: string | null | undefined): number | null {
  const match = str?.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!match) return null;
  return Math.round(parseFloat(match[1]) * DURATION_UNIT_MS[match[2].toLowerCase()]);
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const [unitMs, unit] = ms < 86_400_000 ? [3_600_000, 'h'] : [86_400_000, 'd'];
  const value = ms / unitMs;
  return Number.isInteger(value) ? `${value}${unit}` : `${value.toFixed(1)}${unit}`;
}

/** A positive duration: a unit string, or a number of milliseconds. A bare digit string is
 *  rejected so "30" is never silently read as 30 ms. */
export function parseDurationMs(value: string | number | undefined, field: string): number {
  if (value === undefined || value === '') {
    throw new ScheduleSpecError(field, `${field} is required (e.g. 30m, 2h, 1d)`);
  }
  const ms = typeof value === 'number' ? Math.round(value) : parseDuration(value);
  if (ms === null || !Number.isFinite(ms) || ms <= 0) {
    throw new ScheduleSpecError(field, `invalid ${field}: '${value}' (use 30s, 5m, 2h, 1d)`, value);
  }
  return ms;
}

export function parseTime(value: string | undefined): string {
  if (!value) throw new ScheduleSpecError('time', 'time is required (HH:MM, 24-hour)');
  const match = value.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new ScheduleSpecError('time', `invalid time: '${value}' (use HH:MM, 24-hour)`, value);
  }
  return match[0];
}

export function parseDayOfWeek(value: string | number | undefined): number {
  if (value === undefined || value === '') {
    throw new ScheduleSpecError('dayOfWeek', 'dayOfWeek is required (sun..sat or 0-6)');
  }
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : value;
  const day = typeof raw === 'number' || /^\d+$/.test(raw) ? Number(raw) : DAY_MAP[raw];
  if (!Number.isInteger(day) || day < 0 || day > 6) {
    throw new ScheduleSpecError('dayOfWeek', `invalid dayOfWeek: '${value}' (use sun..sat or 0-6)`, value);
  }
  return day;
}

export function normalizeMessage(value: unknown): string {
  const message = typeof value === 'string' ? value.trim() : '';
  if (!isValidDispatchPrompt(message)) {
    throw new ScheduleSpecError('message', 'message must be a non-empty prompt', value);
  }
  return message;
}

export function isScheduleType(type: unknown): type is ScheduleType {
  return SCHEDULE_TYPES.includes(type as ScheduleType);
}

const TIMING_PARSERS: Record<ScheduleType, (input: ScheduleSpecInput) => ScheduleTiming> = {
  interval: (input) => ({ type: 'interval', intervalMs: parseDurationMs(input.interval, 'interval') }),
  daily: (input) => ({ type: 'daily', time: parseTime(input.time) }),
  weekly: (input) => ({ type: 'weekly', dayOfWeek: parseDayOfWeek(input.dayOfWeek), time: parseTime(input.time) }),
  once: (input) => ({ type: 'once', delayMs: parseDurationMs(input.delay, 'delay') }),
};

/** Validate and type one schedule request. Every entry point (MCP tool, `cortex schedule`,
 *  `!schedule`, the web UI) parses its own syntax into ScheduleSpecInput and comes through here. */
export function normalizeScheduleSpec(input: ScheduleSpecInput): ScheduleSpec {
  if (!isScheduleType(input.type)) {
    throw new ScheduleSpecError('type', `invalid type: '${input.type}' (valid: ${SCHEDULE_TYPES.join(', ')})`, input.type);
  }
  const timing = TIMING_PARSERS[input.type](input);
  const preCheck = input.preCheck?.trim();
  return {
    ...timing,
    message: normalizeMessage(input.message),
    projectId: input.projectId?.trim() || 'general',
    profile: input.profile?.trim() || null,
    ...(preCheck ? { preCheck } : {}),
  };
}

const BUILTIN_JOB_DISPATCH_TYPES = new Set(['memory-index-regen']);
const COMMON_PATCH_FIELDS = ['message', 'projectId', 'profile', 'dispatchType', 'preCheck'];
export const TIMING_PATCH_FIELDS: Record<ScheduleType, readonly (keyof SchedulePatch)[]> = {
  interval: ['intervalMs'],
  daily: ['time'],
  weekly: ['dayOfWeek', 'time'],
  once: ['runAt'],
};

function assertPatchFields(type: ScheduleType, patch: SchedulePatch): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) throw new ScheduleSpecError('patch', 'nothing to update — provide at least one field');
  const allowed = new Set<string>([...COMMON_PATCH_FIELDS, ...TIMING_PATCH_FIELDS[type]]);
  const invalid = keys.filter((key) => !allowed.has(key));
  if (invalid.length) throw new ScheduleSpecError('patch', `invalid fields for ${type}: ${invalid.join(', ')}`, invalid);
}

function assertPatchValues(patch: SchedulePatch): void {
  if (patch.dispatchType && BUILTIN_JOB_DISPATCH_TYPES.has(patch.dispatchType)) {
    throw new ScheduleSpecError('dispatchType', `built-in job dispatch type cannot be scheduled: ${patch.dispatchType}`);
  }
  if ('intervalMs' in patch) parseDurationMs(patch.intervalMs, 'intervalMs');
  if ('dayOfWeek' in patch) parseDayOfWeek(patch.dayOfWeek);
  if ('runAt' in patch && !(Number.isFinite(patch.runAt) && patch.runAt! > 0)) {
    throw new ScheduleSpecError('runAt', 'runAt must be a positive epoch ms', patch.runAt);
  }
}

/** Validate a patch against the schedule it changes; returns it with message/time normalized. */
export function normalizeSchedulePatch(type: ScheduleType, patch: SchedulePatch): SchedulePatch {
  assertPatchFields(type, patch);
  assertPatchValues(patch);
  const normalized = { ...patch };
  if ('message' in patch) normalized.message = normalizeMessage(patch.message);
  if ('time' in patch) normalized.time = parseTime(patch.time);
  return normalized;
}

function msUntilDaily(time: string, now: number): number {
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now;
}

function msUntilWeekly(dayOfWeek: number, time: string, now: number): number {
  const [hours, minutes] = time.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  let daysAhead = (dayOfWeek - next.getDay() + 7) % 7;
  if (daysAhead === 0 && next.getTime() <= now) daysAhead = 7;
  next.setDate(next.getDate() + daysAhead);
  return next.getTime() - now;
}

/** Delay from `now` until a recurring task should fire next. */
export function nextFireDelayMs(task: Pick<ScheduleTask, 'type' | 'intervalMs' | 'time' | 'dayOfWeek'>, now = Date.now()): number {
  if (task.type === 'daily') return msUntilDaily(task.time!, now);
  if (task.type === 'weekly') return msUntilWeekly(task.dayOfWeek!, task.time!, now);
  return task.intervalMs || 60_000;
}

/** Recompute nextRun after a recurring task's timing or pause state changed. A once task keeps
 *  its runAt. */
export function retimeTask(task: ScheduleTask, now = Date.now()): void {
  if (task.type === 'once') return;
  task.nextRun = task.isPaused ? null : now + nextFireDelayMs(task, now);
}

/** The persisted record for a new schedule. `profile` is already resolved by the caller. */
export function buildScheduleTask(spec: ScheduleSpec, id: string, now: number, profile: string): ScheduleTask {
  const { message, projectId, preCheck, profile: _profile, ...timing } = spec;
  const base = { id, message, projectId, profile, preCheck, createdAt: now };
  if (timing.type === 'once') return { ...base, type: 'once', runAt: now + timing.delayMs };
  const task: ScheduleTask = { ...base, ...timing, lastRun: null, nextRun: null };
  retimeTask(task, now);
  return task;
}
