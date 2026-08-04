// input:  UiServiceDeps + SchedulesListParams
// output: handleSchedulesList → ScheduleInfo[]
// pos:    query handler for 'schedules.list'

import type { UiServiceDeps, ScheduleInfo, SchedulesListParams } from '../types.js';

export async function handleSchedulesList(
  deps: UiServiceDeps,
  params: SchedulesListParams,
): Promise<ScheduleInfo[]> {
  const { projectId, paused } = params;

  let schedules = await deps.scheduler.list();

  if (projectId) {
    schedules = schedules.filter((s) => s.projectId === projectId);
  }
  if (paused !== undefined) {
    schedules = schedules.filter((s) => (s.isPaused ?? false) === paused);
  }

  return schedules.map((s): ScheduleInfo => ({
    id: s.id,
    type: s.type,
    message: s.message,
    projectId: s.projectId,
    profile: s.profile ?? null,
    nextRun: s.nextRun != null ? new Date(s.nextRun).toISOString() : null,
    lastRun: s.lastRun != null ? new Date(s.lastRun).toISOString() : null,
    paused: s.isPaused ?? false,
    pausedBy: (s as any).pausedBy ?? null,
    intervalMs: s.intervalMs ?? null,
    time: s.time ?? null,
    dayOfWeek: s.dayOfWeek ?? null,
    target: s.target ?? null,
    fallback: s.fallback ?? null,
  }));
}
