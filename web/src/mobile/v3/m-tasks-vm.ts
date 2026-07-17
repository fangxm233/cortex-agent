// Pure view-model for the 1d 任务 screen (scheme-mobile.dc.html 1d L240-284). 1d is the current
// project's read-only task queue. The 可执行 segment shows 进行中 / 可执行; the 全部 segment adds
// 阻塞 and 完成 (done) — the done group is desktop parity (the desktop Tasks tab surfaces done in its
// 全部 scope). It reuses the shared `groupMobileTasks` bucketing (which also yields a waiting-deps
// bucket) but 1d deliberately has no waiting-deps group — those tasks are still counted in the 全部
// segment yet have no row here (they live on desktop). Framework-free so the mapping is unit-testable.
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
  const scoped = segment === 'executable' ? views.filter((v) => !ALL_ONLY_KEYS.has(v.key)) : views;
  return scoped.filter((v) => v.tasks.length > 0);
}
