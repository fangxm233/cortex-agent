// Pure task-grouping logic for the mobile 5c 任务 screen (scheme.dc.html L3110-3195). Maps the real
// `tasks.list` DTO into the scheme's four lifecycle groups + the 可执行/全部 segmented counts. Kept
// framework-free so the DTO→scheme mapping is unit-testable in isolation (RB pure-vm precedent).
import type { TaskInfo } from '@cortex-agent/ui-contract';

export type MobileTaskGroup = 'in-progress' | 'claimable' | 'waiting-deps' | 'blocked';

/**
 * Is any of `t`'s dependencies still open (not done)? The DTO `actionable` flag is computed WITHOUT
 * checking dependency satisfaction, so a dep-waiting task comes back `actionable:true` — we recover
 * the real 等依赖 signal by joining `dependsOn` against the list's status map (desktop TaskModal
 * dependency-join precedent). A dep id not present in the list is treated as satisfied (can't prove
 * unmet — e.g. archived / cross-project).
 */
export function hasUnmetDependencies(
  t: TaskInfo,
  statusById: Map<string, TaskInfo['status']>,
): boolean {
  return t.dependsOn.some((dep) => statusById.get(dep) === 'open');
}

/**
 * Classify one task into a scheme group. Precedence (top→down): blocked → in-progress →
 * waiting-deps → claimable, so an overlapping task lands in the higher-attention group. `unmetDeps`
 * is the pre-computed dependency-join result (see `hasUnmetDependencies`).
 */
export function classifyMobileTask(t: TaskInfo, unmetDeps: boolean): MobileTaskGroup {
  if (t.blockedBy != null) return 'blocked';
  if (t.claimedBy != null) return 'in-progress';
  if (unmetDeps) return 'waiting-deps';
  if (t.actionable) return 'claimable';
  return 'waiting-deps';
}

export interface MobileTasksGrouped {
  inProgress: TaskInfo[];
  claimable: TaskInfo[];
  waitingDeps: TaskInfo[];
  blocked: TaskInfo[];
  done: TaskInfo[];
}

/**
 * Bucket tasks by classifier. Open tasks fall into the four lifecycle groups; done tasks collect in
 * their own `done` bucket (shown only in the 全部 segment, parity with desktop). Stable order.
 */
export function groupMobileTasks(tasks: TaskInfo[]): MobileTasksGrouped {
  const statusById = new Map<string, TaskInfo['status']>(tasks.map((t) => [t.id, t.status]));
  const g: MobileTasksGrouped = {
    inProgress: [],
    claimable: [],
    waitingDeps: [],
    blocked: [],
    done: [],
  };
  for (const t of tasks) {
    if (t.status === 'done') {
      g.done.push(t);
      continue;
    }
    if (t.status !== 'open') continue;
    switch (classifyMobileTask(t, hasUnmetDependencies(t, statusById))) {
      case 'in-progress':
        g.inProgress.push(t);
        break;
      case 'claimable':
        g.claimable.push(t);
        break;
      case 'waiting-deps':
        g.waitingDeps.push(t);
        break;
      case 'blocked':
        g.blocked.push(t);
        break;
    }
  }
  return g;
}

/**
 * 可执行 count = in-progress + claimable (the executable/executing working set). Matches the scheme
 * mock arithmetic 可执行 3 = 进行中(1) + 可认领(2).
 */
export function executableCount(grouped: MobileTasksGrouped): number {
  return grouped.inProgress.length + grouped.claimable.length;
}

/** 全部 count = every open task in the queue (all four groups). */
export function allOpenCount(grouped: MobileTasksGrouped): number {
  return (
    grouped.inProgress.length +
    grouped.claimable.length +
    grouped.waitingDeps.length +
    grouped.blocked.length
  );
}

/** 全部 count including done — the mobile 全部 segment mirrors desktop's total (open + done). */
export function allCount(grouped: MobileTasksGrouped): number {
  return allOpenCount(grouped) + grouped.done.length;
}

export type MobileSegment = 'executable' | 'all';

export interface MobileGroupView {
  group: MobileTaskGroup;
  tasks: TaskInfo[];
}

/**
 * Ordered, non-empty group views for a segment. `all` shows the four groups in scheme order;
 * `executable` shows only 进行中 + 可认领 (the executable working set).
 */
export function orderedGroups(grouped: MobileTasksGrouped, segment: MobileSegment): MobileGroupView[] {
  const all: MobileGroupView[] = [
    { group: 'in-progress', tasks: grouped.inProgress },
    { group: 'claimable', tasks: grouped.claimable },
    { group: 'waiting-deps', tasks: grouped.waitingDeps },
    { group: 'blocked', tasks: grouped.blocked },
  ];
  const scoped =
    segment === 'executable'
      ? all.filter((g) => g.group === 'in-progress' || g.group === 'claimable')
      : all;
  return scoped.filter((g) => g.tasks.length > 0);
}

/** Per-group status dot color — verbatim from scheme L3127/3138/3166/3177 (§8.3 raw values). */
export const MOBILE_GROUP_DOT: Record<MobileTaskGroup, string> = {
  'in-progress': '#C03D33',
  claimable: '#C99A2E',
  'waiting-deps': '#C99A2E',
  blocked: '#C99A2E',
};
