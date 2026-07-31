// input:  Grouped mobile task fixtures and fixed list model
// output: Complete six-group mobile task order regressions
// pos:    Mobile task-list view-model unit tests
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { groupMobileTasks } from '@/mobile/mobile-tasks';
import { buildMTaskGroups } from './m-tasks-vm';

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

describe('buildMTaskGroups', () => {
  const grouped = groupMobileTasks([
    task({ id: 'running', claimedBy: 'task-dispatcher' }),
    task({ id: 'ready', actionable: true }),
    task({ id: 'approval', approvalNeeded: true, actionable: true }),
    task({ id: 'waiting', actionable: true, dependsOn: ['running'] }),
    task({ id: 'blocked', blockedBy: 'offline' }),
    task({ id: 'done', status: 'done' }),
  ]);

  it('always returns the complete lifecycle order', () => {
    expect(buildMTaskGroups(grouped).map((group) => group.key)).toEqual([
      'in-progress',
      'actionable',
      'approval-needed',
      'waiting-deps',
      'blocked',
      'done',
    ]);
  });

  it('carries the real task into each lifecycle group', () => {
    const views = buildMTaskGroups(grouped);
    expect(views.find((group) => group.key === 'actionable')?.tasks.map((item) => item.id)).toEqual(['ready']);
    expect(views.find((group) => group.key === 'approval-needed')?.tasks.map((item) => item.id)).toEqual(['approval']);
    expect(views.find((group) => group.key === 'waiting-deps')?.tasks.map((item) => item.id)).toEqual(['waiting']);
    expect(views.find((group) => group.key === 'done')?.tasks.map((item) => item.id)).toEqual(['done']);
  });

  it('drops empty groups without introducing a scope filter', () => {
    const views = buildMTaskGroups(groupMobileTasks([task({ id: 'ready', actionable: true })]));
    expect(views.map((group) => group.key)).toEqual(['actionable']);
  });
});
