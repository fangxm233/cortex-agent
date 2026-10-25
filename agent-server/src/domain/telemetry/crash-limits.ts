import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { TELEMETRY_DIR } from './paths.js';

export const CRASH_GROUP_INTERVAL_MS = 60 * 60 * 1000;
export const CRASH_DAILY_LIMIT = 20;
export const CRASH_LIMITS_FILE = path.join(TELEMETRY_DIR, 'crash-limits.json');

interface GroupState { lastSentAt: number; suppressed: number }
interface LimitState { day: string; sentToday: number; groups: Record<string, GroupState> }

export interface CrashAdmission {
  send: boolean;
  /** Same-group crashes held back since the last one sent (reported on this one). */
  suppressed: number;
}

function read(file: string, day: string): LimitState {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as LimitState;
    if (state.day === day && state.groups && typeof state.sentToday === 'number') return state;
    return { day, sentToday: 0, groups: state.groups ?? {} };
  } catch {
    return { day, sentToday: 0, groups: {} };
  }
}

function write(file: string, state: LimitState, now: number): void {
  for (const [key, group] of Object.entries(state.groups)) {
    if (now - group.lastSentAt > 24 * CRASH_GROUP_INTERVAL_MS && group.suppressed === 0) delete state.groups[key];
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state), 'utf8');
  } catch { /* an unwritable home only loses the limiter */ }
}

/**
 * One crash per group per hour, twenty per install per UTC day. Held-back crashes are only
 * counted, and the count rides on the next crash of that group that goes out. Synchronous: the
 * caller may be a process about to exit.
 */
export function admitCrash(groupKey: string, now = Date.now(), file = CRASH_LIMITS_FILE): CrashAdmission {
  const state = read(file, new Date(now).toISOString().slice(0, 10));
  const group = state.groups[groupKey] ?? { lastSentAt: 0, suppressed: 0 };
  const tooSoon = now - group.lastSentAt < CRASH_GROUP_INTERVAL_MS;
  if (tooSoon || state.sentToday >= CRASH_DAILY_LIMIT) {
    state.groups[groupKey] = { ...group, suppressed: group.suppressed + 1 };
    write(file, state, now);
    return { send: false, suppressed: group.suppressed + 1 };
  }
  state.groups[groupKey] = { lastSentAt: now, suppressed: 0 };
  state.sentToday += 1;
  write(file, state, now);
  return { send: true, suppressed: group.suppressed };
}

export function wipeCrashLimits(file = CRASH_LIMITS_FILE): void {
  rmSync(file, { force: true });
}
