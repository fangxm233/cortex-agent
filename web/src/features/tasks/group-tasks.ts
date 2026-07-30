// input:  Task DTOs, lifecycle and dependency state
// output: six lifecycle groups and open-task count
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

/** Bucket tasks into the six fixed lifecycle sections, preserving input order within each. */
export function groupTasks(tasks: TaskInfo[]): TaskGroup[] {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  return LIFECYCLE_ORDER
    .map((kind) => ({ kind, tasks: tasks.filter((task) => classify(task, statusById) === kind) }))
    .filter((group) => group.tasks.length > 0);
}

/** Count of non-done tasks (for the "Actionable" badge in the tab). */
export function actionableOpenCount(tasks: TaskInfo[]): number {
  return tasks.filter((t) => t.status === 'open').length;
}
