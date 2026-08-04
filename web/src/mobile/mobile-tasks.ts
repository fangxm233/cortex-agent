// input:  Task DTOs and dependency status joins
// output: Complete six-group mobile task lifecycle model, done newest-first
// pos:    Shared pure model for the mobile task screen
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { TaskInfo } from '@cortex-agent/ui-contract';
import { unresolvedDependencyIds } from '@/features/tasks/task-dependencies';
import { sortDoneTasks } from '@/features/tasks/group-tasks';

export type MobileTaskGroup =
  | 'in-progress'
  | 'actionable'
  | 'approval-needed'
  | 'waiting-deps'
  | 'blocked'
  | 'done';

export function hasUnmetDependencies(
  task: TaskInfo,
  statusById: ReadonlyMap<string, TaskInfo['status']>,
): boolean {
  return unresolvedDependencyIds(task, statusById).length > 0;
}

type MobileLifecycleRule = {
  kind: MobileTaskGroup;
  matches: (task: TaskInfo, unmetDependencies: boolean) => boolean;
};

const CLASSIFICATION_RULES: readonly MobileLifecycleRule[] = [
  { kind: 'done', matches: (task) => task.status === 'done' },
  { kind: 'blocked', matches: (task) => task.blockedBy != null },
  { kind: 'in-progress', matches: (task) => task.claimedBy != null },
  { kind: 'approval-needed', matches: (task) => task.approvalNeeded === true },
  { kind: 'waiting-deps', matches: (_task, unmetDependencies) => unmetDependencies },
  { kind: 'actionable', matches: (task) => task.actionable },
];

export function classifyMobileTask(task: TaskInfo, unmetDependencies: boolean): MobileTaskGroup {
  return CLASSIFICATION_RULES.find((rule) => rule.matches(task, unmetDependencies))?.kind ?? 'waiting-deps';
}

export interface MobileTasksGrouped {
  inProgress: TaskInfo[];
  actionable: TaskInfo[];
  approvalNeeded: TaskInfo[];
  waitingDeps: TaskInfo[];
  blocked: TaskInfo[];
  done: TaskInfo[];
}

const GROUP_KEYS: Record<MobileTaskGroup, keyof MobileTasksGrouped> = {
  'in-progress': 'inProgress',
  actionable: 'actionable',
  'approval-needed': 'approvalNeeded',
  'waiting-deps': 'waitingDeps',
  blocked: 'blocked',
  done: 'done',
};

export function groupMobileTasks(tasks: TaskInfo[]): MobileTasksGrouped {
  const statusById = new Map(tasks.map((task) => [task.id, task.status]));
  const grouped: MobileTasksGrouped = {
    inProgress: [],
    actionable: [],
    approvalNeeded: [],
    waitingDeps: [],
    blocked: [],
    done: [],
  };
  for (const task of tasks) {
    const kind = classifyMobileTask(task, hasUnmetDependencies(task, statusById));
    grouped[GROUP_KEYS[kind]].push(task);
  }
  grouped.done = sortDoneTasks(grouped.done);
  return grouped;
}
