import type { TaskInfo } from '@cortex-agent/ui-contract';

// Design 4a lifecycle groups (scheme.dc.html L624-745). Tasks are bucketed by lifecycle,
// not by priority, because the task list is primarily driven by the agent's view:
// what's running, what can run next, what's blocked.
export const LIFECYCLE_ORDER = ['in-progress', 'actionable', 'waiting-deps', 'blocked', 'done'] as const;

export type TaskGroupKind = (typeof LIFECYCLE_ORDER)[number];

export interface TaskGroup {
  kind: TaskGroupKind;
  tasks: TaskInfo[];
}

/**
 * Classify a single task into its lifecycle bucket. Classification rules:
 *
 *   blocked   — blockedBy is set (external blocker)
 *   in-progress — claimedBy is set AND not blocked (agent is working on it)
 *   waiting-deps — open, not claimed, not blocked, but NOT actionable (server says deps aren't met)
 *   actionable — open, not claimed, not blocked, actionable=true (ready to claim)
 *   done      — status === 'done'
 */
function classify(t: TaskInfo): TaskGroupKind {
  if (t.status === 'done') return 'done';
  if (t.blockedBy) return 'blocked';
  if (t.claimedBy) return 'in-progress';
  if (t.actionable) return 'actionable';
  return 'waiting-deps';
}

/**
 * Bucket tasks by lifecycle (in-progress → actionable → waiting-deps → blocked → done).
 * Omits empty groups. Preserves input order within each group (stable — filter keeps order).
 */
export function groupTasks(tasks: TaskInfo[]): TaskGroup[] {
  return LIFECYCLE_ORDER
    .map((kind) => ({ kind, tasks: tasks.filter((t) => classify(t) === kind) }))
    .filter((g) => g.tasks.length > 0);
}

/** Count of non-done tasks (for the "Actionable" badge in the tab). */
export function actionableOpenCount(tasks: TaskInfo[]): number {
  return tasks.filter((t) => t.status === 'open').length;
}
