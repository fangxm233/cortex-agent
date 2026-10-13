import { randomBytes } from 'crypto';
import type { ScheduleRepo, ScheduleTask } from '@store/schedule-repo.js';
import { getDefaultProfileName } from '../agents/profile-manager.js';
import {
  buildScheduleTask, normalizeSchedulePatch, retimeTask,
  type ScheduleSpec, type SchedulePatch,
} from './schedule-spec.js';

// Persisted schedule changes, shared by the daemon's Scheduler and `cortex schedule`. These only
// touch schedules.json; the Scheduler arms timers and picks up outside writes through its watcher.

type Repo = Pick<ScheduleRepo, 'mutate' | 'updateTask'>;

export function resolveTaskProfile(profile: string | null | undefined): string {
  return profile || getDefaultProfileName();
}

/** Persist a new schedule. With an idempotency key, a schedule already created under that key is
 *  returned instead of adding a second one. */
export async function addSchedule(
  repo: Repo, spec: ScheduleSpec, opts: { idempotencyKey?: string } = {},
): Promise<{ task: ScheduleTask; created: boolean }> {
  const task = buildScheduleTask(spec, randomBytes(4).toString('hex'), Date.now(), resolveTaskProfile(spec.profile));
  const key = opts.idempotencyKey;
  if (key) task.idempotencyKey = key;
  return repo.mutate<{ task: ScheduleTask; created: boolean }>((data) => {
    const existing = key ? data.tasks.find((t) => t.idempotencyKey === key) : undefined;
    if (existing) return { next: data, result: { task: existing, created: false } };
    data.tasks.push(task);
    return { next: data, result: { task, created: true } };
  });
}

export function updateSchedule(repo: Repo, id: string, patch: SchedulePatch): Promise<ScheduleTask | null> {
  return repo.updateTask(id, (task) => {
    Object.assign(task, normalizeSchedulePatch(task.type, patch));
    retimeTask(task);
  });
}

export function pauseSchedule(repo: Repo, id: string): Promise<ScheduleTask | null> {
  return repo.updateTask(id, (task) => {
    if (task.type === 'once') throw new Error(`cannot pause once schedule ${id}`);
    if (task.isPaused) return;
    Object.assign(task, { isPaused: true, pausedAt: Date.now(), pausedBy: 'user', nextRun: null });
  });
}

export function resumeSchedule(repo: Repo, id: string): Promise<ScheduleTask | null> {
  return repo.updateTask(id, (task) => {
    if (task.type === 'once') throw new Error(`cannot resume once schedule ${id}`);
    if (!task.isPaused) return;
    Object.assign(task, { isPaused: false, pausedAt: null, pausedBy: null });
    retimeTask(task);
  });
}
