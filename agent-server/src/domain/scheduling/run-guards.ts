import type { ExecutionRecord } from '../executions/registry.js';

/** Reject prompts that would start a run with nothing to do: null, empty, whitespace, or the
 *  literal strings a lost value stringifies to. */
export function isValidDispatchPrompt(value: unknown): boolean {
  if (!value || typeof value === 'object') return false;
  const s = typeof value === 'string' ? value : String(value);
  if (!s.trim()) return false;
  if (s === 'null' || s === 'undefined') return false;
  return true;
}

/** True while a run fired by this schedule is still executing. */
export function hasRunningExecutionForSchedule(
  records: Pick<ExecutionRecord, 'status' | 'kind' | 'scheduleTaskId'>[],
  scheduleTaskId: string,
): boolean {
  return records.some((record) =>
    record.status === 'running' &&
    record.kind === 'scheduled' &&
    record.scheduleTaskId === scheduleTaskId
  );
}
