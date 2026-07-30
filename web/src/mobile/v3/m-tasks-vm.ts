// input:  Complete grouped mobile task lifecycle model
// output: Ordered non-empty mobile task group views
// pos:    Pure view model for the mobile Tasks screen
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { TaskInfo } from '@cortex-agent/ui-contract';
import type { MobileTasksGrouped } from '@/mobile/mobile-tasks';

export type MTaskGroupKey =
  | 'in-progress'
  | 'actionable'
  | 'approval-needed'
  | 'waiting-deps'
  | 'blocked'
  | 'done';

export interface MTaskGroupView {
  key: MTaskGroupKey;
  tasks: TaskInfo[];
}

export function buildMTaskGroups(grouped: MobileTasksGrouped): MTaskGroupView[] {
  const groups: MTaskGroupView[] = [
    { key: 'in-progress', tasks: grouped.inProgress },
    { key: 'actionable', tasks: grouped.actionable },
    { key: 'approval-needed', tasks: grouped.approvalNeeded },
    { key: 'waiting-deps', tasks: grouped.waitingDeps },
    { key: 'blocked', tasks: grouped.blocked },
    { key: 'done', tasks: grouped.done },
  ];
  return groups.filter((group) => group.tasks.length > 0);
}
