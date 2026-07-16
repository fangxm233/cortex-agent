// Pure view-model for the 1d 任务 screen (scheme-mobile.dc.html 1d L240-284). 1d is the current
// project's read-only task queue with exactly THREE lifecycle group headers: 进行中 / 可执行 / 阻塞
// (L254/L259/L270). It reuses the shared `groupMobileTasks` bucketing (which also yields a
// waiting-deps bucket) but 1d deliberately has no waiting-deps group — those tasks are still counted
// in the 全部 segment (allOpenCount) yet have no row here (they live on desktop; the scheme mock's
// 全部 7 vs 5 rendered rows encodes exactly this). Kept framework-free so the mapping is unit-testable.
import type { TaskInfo } from '@cortex-agent/ui-contract';
import type { MobileTasksGrouped, MobileSegment } from '@/mobile/mobile-tasks';

export type MTaskGroupKey = 'in-progress' | 'claimable' | 'blocked';

export interface MTaskGroupView {
  key: MTaskGroupKey;
  tasks: TaskInfo[];
}

/**
 * The three 1d group views for a segment, in scheme order, empty groups dropped.
 * - `executable` → 进行中 + 可执行 (the in-progress + claimable working set; blocked hidden).
 * - `all` → 进行中 + 可执行 + 阻塞.
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
  ];
  const scoped = segment === 'executable' ? views.filter((v) => v.key !== 'blocked') : views;
  return scoped.filter((v) => v.tasks.length > 0);
}
