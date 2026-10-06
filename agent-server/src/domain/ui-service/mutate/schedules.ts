import { t } from '@core/i18n.js';
import {
  normalizeSchedulePatch, normalizeScheduleSpec, ScheduleSpecError, type SchedulePatch,
} from '../../scheduling/schedule-spec.js';
import type { UiServiceDeps, Result, ScheduleInfo, MutateArgs } from '../types.js';
import { toScheduleInfo } from '../query/schedules.js';

export async function handlePauseSchedule(
  deps: UiServiceDeps,
  args: { scheduleId: string },
): Promise<Result<void>> {
  try {
    const updated = await deps.scheduler.pause(args.scheduleId);
    if (!updated) {
      return { ok: false, code: 'not-found', message: t('ui.schedule.notFound', { id: args.scheduleId }) };
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
      return { ok: false, code: 'not-found', message: t('ui.schedule.notFound', { id: args.scheduleId }) };
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
      return { ok: false, code: 'not-found', message: t('ui.schedule.notFound', { id: args.scheduleId }) };
    }
    return { ok: true, data: undefined };
  } catch (err: any) {
    return { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}

function invalidArgs(err: unknown): Result<never> | null {
  return err instanceof ScheduleSpecError ? { ok: false, code: 'invalid-args', message: err.message } : null;
}

// Create a schedule (DR-0018 §2.1 7c). The spec is validated before deps.scheduler.add, so an invalid
// request is an Err with nothing written.
export async function handleAddSchedule(
  deps: UiServiceDeps,
  args: MutateArgs<'schedules.add'>,
): Promise<Result<ScheduleInfo>> {
  try {
    const spec = normalizeScheduleSpec({ ...args, interval: args.intervalMs });
    return { ok: true, data: toScheduleInfo(await deps.scheduler.add(spec)) };
  } catch (err: any) {
    return invalidArgs(err) ?? { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}

function buildUpdatePatch(args: MutateArgs<'schedules.update'>): SchedulePatch {
  const { scheduleId: _id, ...rest } = args;
  return Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
}

// Patch an existing schedule. The patch is checked against the persisted task's type BEFORE calling
// update, so a foreign timing field is an Err with nothing written.
export async function handleUpdateSchedule(
  deps: UiServiceDeps,
  args: MutateArgs<'schedules.update'>,
): Promise<Result<ScheduleInfo>> {
  const task = await deps.scheduler.get(args.scheduleId);
  if (!task) {
    return { ok: false, code: 'not-found', message: t('ui.schedule.notFound', { id: args.scheduleId }) };
  }
  try {
    const updated = await deps.scheduler.update(args.scheduleId, normalizeSchedulePatch(task.type, buildUpdatePatch(args)));
    if (!updated) {
      return { ok: false, code: 'not-found', message: t('ui.schedule.notFound', { id: args.scheduleId }) };
    }
    return { ok: true, data: toScheduleInfo(updated) };
  } catch (err: any) {
    return invalidArgs(err) ?? { ok: false, code: 'internal', message: err?.message || String(err) };
  }
}
