//
// Single-task done-when EVIDENCE + per-task dispatch history. Evidence is drawn from the REAL
// completion sources — the task store's `completed-note` / `completed-at` / status, plus the
// terminal execution that completed the task (its finalOutput). Dispatch history is the full
// per-task execution join by `dispatch.taskId`. Every field with no structured source is an honest
// null / [] — never fabricated.

import { t } from '@core/i18n.js';
import type {
  UiServiceDeps,
  TaskVerificationParams,
  TaskVerificationInfo,
  TaskDispatchRecord,
} from '../types.js';

const TERMINAL_STATUSES = new Set(['completed']);

function toDispatchRecord(e: any): TaskDispatchRecord {
  const startedAt = e.runtime?.startedAt || '';
  const finishedAt = e.runtime?.endedAt || null;
  const startMs = startedAt ? new Date(startedAt).getTime() : NaN;
  const endMs = finishedAt ? new Date(finishedAt).getTime() : null;
  return {
    executionId: e.id,
    type: e.kind === 'dispatch' ? 'dispatch' : 'local',
    status: e.status,
    machine: e.dispatch?.machine ?? null,
    threadId: e.thread?.threadId ?? null,
    startedAt,
    finishedAt,
    durationMs: endMs !== null && Number.isFinite(startMs) ? endMs - startMs : null,
    cost: e.metrics?.costUsd ?? null,
  };
}

export async function handleTaskVerification(
  deps: UiServiceDeps,
  params: TaskVerificationParams,
): Promise<TaskVerificationInfo> {
  const { projectId, taskId } = params;

  deps.taskStore.refresh();
  const task = deps.taskStore.getById(taskId);
  if (!task || task.project !== projectId) {
    throw Object.assign(new Error(t('ui.task.notFound', { id: `${projectId}/${taskId}` })), { code: 'not-found' });
  }

  // Per-task execution/dispatch join by taskId, newest first.
  const execs = deps.executionRegistry
    .getAll()
    .filter((e: any) => e.dispatch?.taskId === taskId);
  const dispatches = execs
    .map(toDispatchRecord)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  // Completing execution = the most-recent terminal (completed) execution joined to this task.
  const completing = execs
    .filter((e: any) => TERMINAL_STATUSES.has(e.status))
    .sort((a: any, b: any) =>
      (b.runtime?.endedAt || b.runtime?.startedAt || '').localeCompare(
        a.runtime?.endedAt || a.runtime?.startedAt || '',
      ),
    )[0] ?? null;

  const completed = task.status === 'done';

  return {
    taskId: task.id,
    project: task.project,
    evidence: {
      doneWhen: task.done_when || null,
      completed,
      completedAt: task.completed_at ?? null,
      completedNote: task.completed_note ?? null,
      completingExecutionId: completing ? completing.id : null,
      completingOutput: completing ? (completing.text?.finalOutput ?? null) : null,
    },
    dispatches,
  };
}
