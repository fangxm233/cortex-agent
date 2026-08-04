// input:  Mobile task DTO fixtures and lifecycle grouping model
// output: Six-group mobile task lifecycle regressions
// pos:    Unit tests for mobile task classification
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { classifyMobileTask, groupMobileTasks, hasUnmetDependencies } from './mobile-tasks';

function task(overrides: Partial<TaskInfo>): TaskInfo {
  return {
    id: 'task-a',
    text: 'a task',
    project: 'nimbus',
    status: 'open',
    priority: 'medium',
    actionable: false,
    claimedBy: null,
    claimThreadId: null,
    blockedBy: null,
    approvalNeeded: false,
    dependsOn: [],
    plan: null,
    template: 'coder-review',
    why: null,
    doneWhen: null,
    ...overrides,
  };
}

describe('classifyMobileTask', () => {
  it('blocked takes precedence over every other open state', () => {
    expect(classifyMobileTask(task({ blockedBy: 'offline', claimedBy: 'owner' }), true)).toBe('blocked');
  });

  it('claimed becomes in-progress when not blocked', () => {
    expect(classifyMobileTask(task({ claimedBy: 'task-dispatcher' }), false)).toBe('in-progress');
  });

  it('approval needed precedes actionable and dependency waiting', () => {
    expect(classifyMobileTask(task({ approvalNeeded: true, actionable: true }), true)).toBe('approval-needed');
  });

  it('an open dependency overrides the deps-blind actionable flag', () => {
    expect(classifyMobileTask(task({ actionable: true, dependsOn: ['dependency'] }), true)).toBe('waiting-deps');
  });

  it('actionable with satisfied dependencies becomes actionable', () => {
    expect(classifyMobileTask(task({ actionable: true }), false)).toBe('actionable');
  });

  it('non-actionable without another state falls back to waiting', () => {
    expect(classifyMobileTask(task({}), false)).toBe('waiting-deps');
  });
});

describe('hasUnmetDependencies', () => {
  const statusById = new Map<string, TaskInfo['status']>([
    ['done-1', 'done'],
    ['open-1', 'open'],
  ]);

  it('is true only when a known dependency is still open', () => {
    expect(hasUnmetDependencies(task({ dependsOn: ['open-1'] }), statusById)).toBe(true);
    expect(hasUnmetDependencies(task({ dependsOn: ['done-1'] }), statusById)).toBe(false);
    expect(hasUnmetDependencies(task({ dependsOn: ['unknown'] }), statusById)).toBe(false);
    expect(hasUnmetDependencies(task({ dependsOn: [] }), statusById)).toBe(false);
  });
});

describe('groupMobileTasks', () => {
  it('places every task into one of the six complete-list groups', () => {
    const grouped = groupMobileTasks([
      task({ id: 'running', claimedBy: 'task-dispatcher' }),
      task({ id: 'ready', actionable: true }),
      task({ id: 'approval', approvalNeeded: true, actionable: true }),
      task({ id: 'waiting', actionable: true, dependsOn: ['running'] }),
      task({ id: 'blocked', blockedBy: 'robot offline' }),
      task({ id: 'done', status: 'done' }),
    ]);

    expect(grouped.inProgress.map((item) => item.id)).toEqual(['running']);
    expect(grouped.actionable.map((item) => item.id)).toEqual(['ready']);
    expect(grouped.approvalNeeded.map((item) => item.id)).toEqual(['approval']);
    expect(grouped.waitingDeps.map((item) => item.id)).toEqual(['waiting']);
    expect(grouped.blocked.map((item) => item.id)).toEqual(['blocked']);
    expect(grouped.done.map((item) => item.id)).toEqual(['done']);
  });

  it('uses server-resolved dependencies outside the project-scoped list', () => {
    const grouped = groupMobileTasks([
      task({ id: 'waiting', actionable: true, dependsOn: ['cross-project'], unmetDependencyIds: ['cross-project'] }),
    ]);
    expect(grouped.waitingDeps.map((item) => item.id)).toEqual(['waiting']);
  });

  it('treats completed dependencies as satisfied', () => {
    const grouped = groupMobileTasks([
      task({ id: 'dependency', status: 'done' }),
      task({ id: 'ready', actionable: true, dependsOn: ['dependency'], unmetDependencyIds: [] }),
    ]);
    expect(grouped.actionable.map((item) => item.id)).toEqual(['ready']);
    expect(grouped.waitingDeps).toEqual([]);
  });

  it('preserves input order within an open group', () => {
    const grouped = groupMobileTasks([
      task({ id: 'first', actionable: true }),
      task({ id: 'second', actionable: true }),
    ]);
    expect(grouped.actionable.map((item) => item.id)).toEqual(['first', 'second']);
  });

  it('orders done newest-completed-first, untimed entries last', () => {
    const grouped = groupMobileTasks([
      task({ id: 'oldest', status: 'done', completedAt: '2026-08-01T10:00:00.000Z' }),
      task({ id: 'untimed', status: 'done' }),
      task({ id: 'newest', status: 'done', completedAt: '2026-08-03T10:00:00.000Z' }),
    ]);
    expect(grouped.done.map((item) => item.id)).toEqual(['newest', 'oldest', 'untimed']);
  });
});
