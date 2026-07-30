// input:  grouped tasks and executable/recent/all segment
// output: ordered mobile task group views
// pos:    Pure view model for the mobile Tasks screen
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { TaskInfo } from '@cortex-agent/ui-contract';
import type { MobileTasksGrouped, MobileSegment } from '@/mobile/mobile-tasks';

export type MTaskGroupKey = 'in-progress' | 'claimable' | 'blocked' | 'done';

export interface MTaskGroupView {
  key: MTaskGroupKey;
  tasks: TaskInfo[];
}

/** Groups that only appear in the 全部 segment (hidden from the 可执行 working set). */
const ALL_ONLY_KEYS: ReadonlySet<MTaskGroupKey> = new Set<MTaskGroupKey>(['blocked', 'done']);

/**
 * The 1d group views for a segment, in scheme order, empty groups dropped.
 * - `executable` → 进行中 + 可执行 (the in-progress + claimable working set; blocked/done hidden).
 * - `all` → 进行中 + 可执行 + 阻塞 + 完成 (done shown last, parity with desktop).
 * waiting-deps is never a 1d group (see module note) — it is only reflected in the 全部 count.
 */
export function buildMTaskGroups(
  grouped: MobileTasksGrouped,
  segment: MobileSegment,
): MTaskGroupView[] {
  const views: MTaskGroupView[] = [
    { key: 'in-progress', tasks: grouped.inProgress },
    { key: 'claimable', tasks: grouped.claimable },
    { key: 'blocked', tasks: grouped.blocked },
    { key: 'done', tasks: grouped.done },
  ];
  if (segment === 'recent') return views.filter((view) => view.key === 'done' && view.tasks.length > 0);
  const scoped = segment === 'executable' ? views.filter((view) => !ALL_ONLY_KEYS.has(view.key)) : views;
  return scoped.filter((view) => view.tasks.length > 0);
}
