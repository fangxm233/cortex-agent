import { describe, it, expect } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import {
  classifyMobileTask,
  groupMobileTasks,
  hasUnmetDependencies,
  executableCount,
  allOpenCount,
  allCount,
  orderedGroups,
  MOBILE_GROUP_DOT,
} from './mobile-tasks';

function task(over: Partial<TaskInfo>): TaskInfo {
  return {
    id: 'T-000',
    text: 'a task',
    project: 'cortex-self',
    status: 'open',
    priority: 'medium',
    actionable: false,
    claimedBy: null,
    blockedBy: null,
    dependsOn: [],
    plan: null,
    template: 'coder-review',
    why: null,
    doneWhen: null,
    ...over,
  };
}

describe('classifyMobileTask', () => {
  it('blocked (blockedBy set) takes precedence over everything', () => {
    expect(
      classifyMobileTask(task({ blockedBy: 'ssh down', claimedBy: 'thr_1', actionable: true }), true),
    ).toBe('blocked');
  });

  it('claimed (claimedBy set, not blocked) → in-progress', () => {
    expect(classifyMobileTask(task({ claimedBy: 'thr_1' }), false)).toBe('in-progress');
  });

  it('unmet deps beat the (deps-blind) actionable flag → waiting-deps', () => {
    // the DTO computes actionable without checking deps, so a dep-waiting task is actionable:true
    expect(classifyMobileTask(task({ actionable: true, dependsOn: ['T-1'] }), true)).toBe(
      'waiting-deps',
    );
  });

  it('actionable + deps satisfied → claimable', () => {
    expect(classifyMobileTask(task({ actionable: true }), false)).toBe('claimable');
  });

  it('not actionable, no unmet deps (edge) → waiting-deps', () => {
    expect(classifyMobileTask(task({ actionable: false }), false)).toBe('waiting-deps');
  });
});

describe('hasUnmetDependencies', () => {
  const statusById = new Map<string, TaskInfo['status']>([
    ['done-1', 'done'],
    ['open-1', 'open'],
  ]);

  it('true when a dependency is still open (not done)', () => {
    expect(hasUnmetDependencies(task({ dependsOn: ['open-1'] }), statusById)).toBe(true);
  });

  it('false when all dependencies are done', () => {
    expect(hasUnmetDependencies(task({ dependsOn: ['done-1'] }), statusById)).toBe(false);
  });

  it('false when a dependency is unknown (out of scope — cannot prove unmet)', () => {
    expect(hasUnmetDependencies(task({ dependsOn: ['ghost'] }), statusById)).toBe(false);
  });

  it('false when there are no dependencies', () => {
    expect(hasUnmetDependencies(task({ dependsOn: [] }), statusById)).toBe(false);
  });
});

describe('groupMobileTasks', () => {
  it('buckets by classifier (with dep join); done tasks collect in the done bucket', () => {
    const tasks = [
      task({ id: 'A', claimedBy: 'thr_a' }), // in-progress
      task({ id: 'B', actionable: true }), // claimable
      task({ id: 'C', actionable: true }), // claimable
      task({ id: 'D', actionable: true, dependsOn: ['A'] }), // waiting-deps (A is open)
      task({ id: 'E', blockedBy: 'robot offline' }), // blocked
      task({ id: 'F', status: 'done', actionable: true }), // done
    ];
    const g = groupMobileTasks(tasks);
    expect(g.inProgress.map((t) => t.id)).toEqual(['A']);
    expect(g.claimable.map((t) => t.id)).toEqual(['B', 'C']);
    expect(g.waitingDeps.map((t) => t.id)).toEqual(['D']);
    expect(g.blocked.map((t) => t.id)).toEqual(['E']);
    expect(g.done.map((t) => t.id)).toEqual(['F']);
  });

  it('a task whose deps are all done is claimable, not waiting', () => {
    const g = groupMobileTasks([
      task({ id: 'dep', status: 'done' }),
      task({ id: 'X', actionable: true, dependsOn: ['dep'] }),
    ]);
    expect(g.claimable.map((t) => t.id)).toEqual(['X']);
    expect(g.waitingDeps).toEqual([]);
  });

  it('preserves input order within a group', () => {
    const g = groupMobileTasks([
      task({ id: 'X', actionable: true }),
      task({ id: 'Y', actionable: true }),
    ]);
    expect(g.claimable.map((t) => t.id)).toEqual(['X', 'Y']);
  });
});

describe('segment counts', () => {
  const grouped = groupMobileTasks([
    task({ id: 'A', claimedBy: 'thr_a' }), // in-progress
    task({ id: 'B', actionable: true }), // claimable
    task({ id: 'C', actionable: true }), // claimable
    task({ id: 'D', actionable: true, dependsOn: ['A'] }), // waiting-deps
    task({ id: 'E', blockedBy: 'x' }), // blocked
  ]);

  it('executableCount = in-progress + claimable (scheme 可执行 3 = 1 + 2)', () => {
    expect(executableCount(grouped)).toBe(3);
  });

  it('allOpenCount = every open task across the four groups', () => {
    expect(allOpenCount(grouped)).toBe(5);
  });

  it('allCount adds done tasks on top of the open groups (desktop 全部 parity)', () => {
    const withDone = groupMobileTasks([
      task({ id: 'A', claimedBy: 'thr_a' }),
      task({ id: 'B', actionable: true }),
      task({ id: 'F', status: 'done' }),
      task({ id: 'G', status: 'done' }),
    ]);
    expect(allOpenCount(withDone)).toBe(2);
    expect(allCount(withDone)).toBe(4);
  });
});

describe('orderedGroups', () => {
  const grouped = groupMobileTasks([
    task({ id: 'A', claimedBy: 'thr_a' }),
    task({ id: 'B', actionable: true }),
    task({ id: 'D', actionable: true, dependsOn: ['A'] }),
    task({ id: 'E', blockedBy: 'x' }),
  ]);

  it('all: 进行中 → 可认领 → 等依赖 → 已阻塞 order, non-empty only', () => {
    expect(orderedGroups(grouped, 'all').map((g) => g.group)).toEqual([
      'in-progress',
      'claimable',
      'waiting-deps',
      'blocked',
    ]);
  });

  it('executable: only in-progress + claimable', () => {
    expect(orderedGroups(grouped, 'executable').map((g) => g.group)).toEqual([
      'in-progress',
      'claimable',
    ]);
  });

  it('omits empty groups', () => {
    const g = groupMobileTasks([task({ id: 'B', actionable: true })]);
    expect(orderedGroups(g, 'all').map((x) => x.group)).toEqual(['claimable']);
  });
});

describe('MOBILE_GROUP_DOT', () => {
  it('maps each group to the verbatim scheme dot hex', () => {
    expect(MOBILE_GROUP_DOT['in-progress']).toBe('#C03D33');
    expect(MOBILE_GROUP_DOT.claimable).toBe('#C99A2E');
    expect(MOBILE_GROUP_DOT['waiting-deps']).toBe('#C99A2E');
    expect(MOBILE_GROUP_DOT.blocked).toBe('#C99A2E');
  });
});
