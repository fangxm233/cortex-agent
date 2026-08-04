// input:  UiServiceDeps + { scheduleId } | ScheduleAddArgs | ScheduleUpdateArgs
// output: pause/resume/remove/add/update schedule handlers → Ok<void|ScheduleInfo> | Err
// pos:    mutate handlers for 'schedules.{pause,resume,remove,add,update}'

import type { UiServiceDeps, Result, ScheduleAddArgs, ScheduleUpdateArgs, ScheduleInfo } from '../types.js';
import type { ScheduleTask } from '@store/schedule-repo.js';

/** Map a persisted ScheduleTask → ScheduleInfo DTO (mirrors query/schedules.ts). */
function toScheduleInfo(s: ScheduleTask): ScheduleInfo {
  return {
    id: s.id,
    type: s.type,
    message: s.message,
    projectId: s.projectId,
    profile: s.profile ?? null,
    nextRun: s.nextRun != null ? new Date(s.nextRun).toISOString() : null,
    lastRun: s.lastRun != null ? new Date(s.lastRun).toISOString() : null,
    paused: s.isPaused ?? false,
    pausedBy: s.pausedBy ?? null,
    intervalMs: s.intervalMs ?? null,
    time: s.time ?? null,
    dayOfWeek: s.dayOfWeek ?? null,
    target: s.target ?? null,
    fallback: s.fallback ?? null,
  };
}

export async function handlePauseSchedule(
  deps: UiServiceDeps,
  args: { scheduleId: string },
): Promise<Result<void>> {
  try {
    const updated = await deps.scheduler.pause(args.scheduleId);
    if (!updated) {
      return { ok: false, code: 'not-found', message: `Schedule not found: ${args.scheduleId}` };
    }
    return { ok: true, data: undefined };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}

export async function handleResumeSchedule(
  deps: UiServiceDeps,
  args: { scheduleId: string },
): Promise<Result<void>> {
  try {
    const updated = await deps.scheduler.resume(args.scheduleId);
    if (!updated) {
      return { ok: false, code: 'not-found', message: `Schedule not found: ${args.scheduleId}` };
    }
    return { ok: true, data: undefined };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}

export async function handleRemoveSchedule(
  deps: UiServiceDeps,
  args: { scheduleId: string },
): Promise<Result<void>> {
  try {
    const removed = await deps.scheduler.remove(args.scheduleId);
    if (!removed) {
      return { ok: false, code: 'not-found', message: `Schedule not found: ${args.scheduleId}` };
    }
    return { ok: true, data: undefined };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}

// Create a schedule (DR-0018 §2.1 7c). Re-checks the per-type required fields (mirrors
// domain/mcp/tools/schedule.ts::runScheduleAdd) so a direct facade / unit call is rejected as an Err
// with nothing written; the zod router already rejects the same cases upstream. The injected
// deps.scheduler.add composes the real scheduler.add + schedule-repo backfill of target/fallback.
export async function handleAddSchedule(
  deps: UiServiceDeps,
  args: ScheduleAddArgs,
): Promise<Result<ScheduleInfo>> {
  // Per-type required-field validation — return Err BEFORE calling add() so nothing is written.
  if (args.type === 'interval' && args.intervalMs === undefined) {
    return { ok: false, code: 'invalid-args', message: 'intervalMs is required for type=interval' };
  }
  if ((args.type === 'daily' || args.type === 'weekly') && !args.time) {
    return { ok: false, code: 'invalid-args', message: `time is required for type=${args.type}` };
  }
  if (args.type === 'weekly' && args.dayOfWeek === undefined) {
    return { ok: false, code: 'invalid-args', message: 'dayOfWeek is required for type=weekly' };
  }
  if (args.type === 'once' && args.delay === undefined) {
    return { ok: false, code: 'invalid-args', message: 'delay is required for type=once' };
  }
  if (!args.message) {
    return { ok: false, code: 'invalid-args', message: 'message is required' };
  }

  try {
    const projectId = args.projectId ?? 'general';
    const task = await deps.scheduler.add(args.type, {
      message: args.message,
      projectId,
      profile: args.profile ?? null,
      intervalMs: args.intervalMs,
      time: args.time,
      dayOfWeek: args.dayOfWeek,
      delay: args.delay,
      target: args.target,
      fallback: args.fallback,
    });
    return { ok: true, data: toScheduleInfo(task) };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}

/** Fields patchable per schedule type — mirrors scheduler.validateTaskPatch minus dispatchType/
 *  preCheck (not UI-editable). The type itself is immutable. */
const UPDATE_TIMING_FIELDS: Record<ScheduleTask['type'], string[]> = {
  interval: ['intervalMs'],
  daily: ['time'],
  weekly: ['dayOfWeek', 'time'],
  once: [],
};

function buildUpdatePatch(args: ScheduleUpdateArgs): Record<string, unknown> {
  const { scheduleId: _id, ...rest } = args;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) patch[key] = value;
  }
  return patch;
}

// Patch an existing schedule. Field-allowedness is re-checked against the persisted task's type
// BEFORE calling update, so a foreign timing field is an Err with nothing written (the real
// scheduler.update would also throw — this keeps the error a typed Result instead).
export async function handleUpdateSchedule(
  deps: UiServiceDeps,
  args: ScheduleUpdateArgs,
): Promise<Result<ScheduleInfo>> {
  const task = await deps.scheduler.get(args.scheduleId);
  if (!task) {
    return { ok: false, code: 'not-found', message: `Schedule not found: ${args.scheduleId}` };
  }
  const patch = buildUpdatePatch(args);
  if (Object.keys(patch).length === 0) {
    return { ok: false, code: 'invalid-args', message: 'empty patch — provide at least one field' };
  }
  const allowed = new Set(['message', 'projectId', 'profile', ...UPDATE_TIMING_FIELDS[task.type]]);
  const invalid = Object.keys(patch).filter((key) => !allowed.has(key));
  if (invalid.length > 0) {
    return { ok: false, code: 'invalid-args', message: `invalid fields for ${task.type}: ${invalid.join(', ')}` };
  }
  try {
    const updated = await deps.scheduler.update(args.scheduleId, patch);
    if (!updated) {
      return { ok: false, code: 'not-found', message: `Schedule not found: ${args.scheduleId}` };
    }
    return { ok: true, data: toScheduleInfo(updated) };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}
