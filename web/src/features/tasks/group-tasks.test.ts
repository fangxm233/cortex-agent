import { describe, it, expect } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { groupTasks, actionableOpenCount } from './group-tasks';

function t(partial: Partial<TaskInfo> & Pick<TaskInfo, 'id'>): TaskInfo {
  return {
    text: `task ${partial.id}`,
    project: 'p',
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
    ...partial,
  };
}

describe('groupTasks — design 4a lifecycle grouping', () => {

  it('classifies a pending approval before actionable and dependency waiting', () => {
    const g = groupTasks([
      t({ id: 'dependency' }),
      t({ id: 'a', actionable: true, approvalNeeded: true, dependsOn: ['dependency'] }),
    ]);
    expect(g.find((group) => group.kind === 'approval-needed')?.tasks.map((task) => task.id)).toEqual(['a']);
  });

  it('classifies a blocked task before claimed and dependency states', () => {
    const g = groupTasks([
      t({ id: 'dependency' }),
      t({ id: 'a', blockedBy: 'external', claimedBy: 'agent', dependsOn: ['dependency'] }),
    ]);
    expect(g.find((group) => group.kind === 'blocked')?.tasks.map((task) => task.id)).toEqual(['a']);
  });

  it('classifies a task with an open dependency as waiting even when the DTO says actionable', () => {
    const g = groupTasks([
      t({ id: 'dependency' }),
      t({ id: 'a', actionable: true, dependsOn: ['dependency'] }),
    ]);
    expect(g.find((group) => group.kind === 'waiting-deps')?.tasks.map((task) => task.id)).toEqual([
      'dependency',
      'a',
    ]);
  });

  it('uses server-resolved cross-project dependencies when the dependency is outside the scoped list', () => {
    const g = groupTasks([
      t({ id: 'a', actionable: true, dependsOn: ['cross-project'], unmetDependencyIds: ['cross-project'] }),
    ]);
    expect(g[0].kind).toBe('waiting-deps');
  });

  it('does not invent an unmet dependency for an absent scoped record without a server resolution', () => {
    const g = groupTasks([t({ id: 'a', actionable: true, dependsOn: ['outside-scope'] })]);
    expect(g[0].kind).toBe('actionable');
  });

  it('classifies a task with only completed dependencies as actionable', () => {
    const g = groupTasks([
      t({ id: 'dependency', status: 'done' }),
      t({ id: 'a', actionable: true, dependsOn: ['dependency'], unmetDependencyIds: [] }),
    ]);
    expect(g.find((group) => group.kind === 'actionable')?.tasks.map((task) => task.id)).toEqual(['a']);
  });

  it('groups multiple tasks into their correct lifecycle buckets', () => {
    const g = groupTasks([
      t({ id: 'in-progress', claimedBy: 'agent' }),
      t({ id: 'actionable', actionable: true }),
      t({ id: 'approval', actionable: true, approvalNeeded: true }),
      t({ id: 'blocked', blockedBy: 'ssh down' }),
      t({ id: 'waiting', actionable: false, dependsOn: ['x'] }),
      t({ id: 'done', status: 'done' }),
    ]);
    expect(g.map((grp) => grp.kind)).toEqual([
      'in-progress',
      'actionable',
      'approval-needed',
      'waiting-deps',
      'blocked',
      'done',
    ]);
    expect(g[0].tasks.map((x) => x.id)).toEqual(['in-progress']);
    expect(g[1].tasks.map((x) => x.id)).toEqual(['actionable']);
    expect(g[2].tasks.map((x) => x.id)).toEqual(['approval']);
    expect(g[3].tasks.map((x) => x.id)).toEqual(['waiting']);
    expect(g[4].tasks.map((x) => x.id)).toEqual(['blocked']);
    expect(g[5].tasks.map((x) => x.id)).toEqual(['done']);
  });

  it('orders the done group newest-completed-first', () => {
    const g = groupTasks([
      t({ id: 'oldest', status: 'done', completedAt: '2026-08-01T10:00:00.000Z' }),
      t({ id: 'newest', status: 'done', completedAt: '2026-08-03T10:00:00.000Z' }),
      t({ id: 'middle', status: 'done', completedAt: '2026-08-02T10:00:00.000Z' }),
    ]);
    expect(g[0].tasks.map((x) => x.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('sinks done tasks without a completion timestamp below timestamped ones, in input order', () => {
    const g = groupTasks([
      t({ id: 'no-time-first', status: 'done' }),
      t({ id: 'timed', status: 'done', completedAt: '2026-08-01T10:00:00.000Z' }),
      t({ id: 'no-time-second', status: 'done', completedAt: null }),
    ]);
    expect(g[0].tasks.map((x) => x.id)).toEqual(['timed', 'no-time-first', 'no-time-second']);
  });
});

// Single source for BOTH the panel's Actionable/All chip and the right-panel Tasks tab badge:
// every task that is not done, whatever lifecycle bucket it sits in.
describe('actionableOpenCount — the open (not-done) count behind the Tasks badge', () => {
  it('counts every non-done task, including in-progress / blocked / waiting-deps', () => {
    const all = [
      t({ id: 'a', claimedBy: 'agent' }),       // in-progress (a running dispatch)
      t({ id: 'b', actionable: true }),          // actionable
      t({ id: 'c', blockedBy: 'needs approval' }), // blocked
      t({ id: 'd' }),                            // waiting-deps / paused / pending
      t({ id: 'e', status: 'done' }),            // excluded
    ];
    expect(actionableOpenCount(all)).toBe(4);
  });
});
