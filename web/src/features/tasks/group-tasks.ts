// input:  Task DTOs, lifecycle and dependency state
// output: six lifecycle groups (done newest-first) and open-task count
// pos:    Shared desktop/mobile task list model
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { TaskInfo } from '@cortex-agent/ui-contract';
import { unresolvedDependencyIds } from './task-dependencies';

// Design 4a lifecycle groups (scheme.dc.html L624-745). Tasks are bucketed by lifecycle,
// not by priority, because the task list is primarily driven by the agent's view:
// what's running, what can run next, what's blocked.
export const LIFECYCLE_ORDER = [
  'in-progress',
  'actionable',
  'approval-needed',
  'waiting-deps',
  'blocked',
  'done',
] as const;

export type TaskGroupKind = (typeof LIFECYCLE_ORDER)[number];

export interface TaskGroup {
  kind: TaskGroupKind;
  tasks: TaskInfo[];
}

type LifecycleRule = {
  kind: TaskGroupKind;
  matches: (task: TaskInfo, unmetDependencies: boolean) => boolean;
};

const CLASSIFICATION_RULES: readonly LifecycleRule[] = [
  { kind: 'done', matches: (task) => task.status === 'done' },
  { kind: 'blocked', matches: (task) => task.blockedBy != null },
  { kind: 'in-progress', matches: (task) => task.claimedBy != null },
  { kind: 'approval-needed', matches: (task) => task.approvalNeeded === true },
  { kind: 'waiting-deps', matches: (_task, unmetDependencies) => unmetDependencies },
  { kind: 'actionable', matches: (task) => task.actionable },
];

function classify(
  task: TaskInfo,
  statusById: ReadonlyMap<string, TaskInfo['status']>,
): TaskGroupKind {
  const unmet = unresolvedDependencyIds(task, statusById).length > 0;
  return CLASSIFICATION_RULES.find((rule) => rule.matches(task, unmet))?.kind ?? 'waiting-deps';
}

function completionInstant(task: TaskInfo): number | null {
  const parsed = Date.parse(task.completedAt ?? '');
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Newest-completed-first. `completedAt` is optional on the list DTO (older records, hand-edited
 * YAML), so untimed entries sink below every timed one and keep their input order there.
 */
export function sortDoneTasks(tasks: TaskInfo[]): TaskInfo[] {
  return [...tasks].sort((a, b) => {
    const left = completionInstant(a);
    const right = completionInstant(b);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  });
}

/**
 * Bucket tasks into the six fixed lifecycle sections, preserving input order within each —
 * except `done`, which is ordered newest-completed-first.
 */
export function groupTasks(tasks: TaskInfo[]): TaskGroup[] {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  return LIFECYCLE_ORDER
    .map((kind) => {
      const grouped = tasks.filter((task) => classify(task, statusById) === kind);
      return { kind, tasks: kind === 'done' ? sortDoneTasks(grouped) : grouped };
    })
    .filter((group) => group.tasks.length > 0);
}

/** Count of non-done tasks (for the "Actionable" badge in the tab). */
export function actionableOpenCount(tasks: TaskInfo[]): number {
  return tasks.filter((t) => t.status === 'open').length;
}
