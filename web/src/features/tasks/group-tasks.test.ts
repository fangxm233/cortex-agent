// input:  task DTO fixtures and task list models
// output: lifecycle, count, and recent completion regressions
// pos:    Task list model unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { groupTasks, actionableOpenCount, LIFECYCLE_ORDER, recentCompletedTasks } from './group-tasks';

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
  it('returns empty groups for empty input', () => {
    const g = groupTasks([]);
    expect(g).toEqual([]);
  });

  it('classifies an active claimed task as in-progress', () => {
    const g = groupTasks([t({ id: 'a', claimedBy: 'agent' })]);
    expect(g[0].kind).toBe('in-progress');
    expect(g[0].tasks.map((x) => x.id)).toEqual(['a']);
  });

  it('classifies an actionable task as actionable', () => {
    const g = groupTasks([t({ id: 'a', actionable: true })]);
    expect(g[0].kind).toBe('actionable');
  });

  it('classifies a blocked task as blocked', () => {
    const g = groupTasks([t({ id: 'a', blockedBy: 'external' })]);
    expect(g[0].kind).toBe('blocked');
  });

  it('classifies a non-actionable open task (pending deps) as waiting-deps', () => {
    const g = groupTasks([
      t({ id: 'a', actionable: false, dependsOn: ['b'] }),
    ]);
    expect(g[0].kind).toBe('waiting-deps');
  });

  it('classifies a done task as done', () => {
    const g = groupTasks([t({ id: 'a', status: 'done' })]);
    expect(g[0].kind).toBe('done');
  });

  it('groups multiple tasks into their correct lifecycle buckets', () => {
    const g = groupTasks([
      t({ id: 'in-progress', claimedBy: 'agent' }),
      t({ id: 'actionable', actionable: true }),
      t({ id: 'blocked', blockedBy: 'ssh down' }),
      t({ id: 'waiting', actionable: false, dependsOn: ['x'] }),
      t({ id: 'done', status: 'done' }),
    ]);
    expect(g.map((grp) => grp.kind)).toEqual(['in-progress', 'actionable', 'waiting-deps', 'blocked', 'done']);
    expect(g[0].tasks.map((x) => x.id)).toEqual(['in-progress']);
    expect(g[1].tasks.map((x) => x.id)).toEqual(['actionable']);
    expect(g[2].tasks.map((x) => x.id)).toEqual(['waiting']);
    expect(g[3].tasks.map((x) => x.id)).toEqual(['blocked']);
    expect(g[4].tasks.map((x) => x.id)).toEqual(['done']);
  });

  it('omits empty groups', () => {
    const g = groupTasks([t({ id: 'a', actionable: true })]);
    expect(g.map((grp) => grp.kind)).toEqual(['actionable']);
  });

  it('keeps input order within a group (stable)', () => {
    const g = groupTasks([
      t({ id: 'first', actionable: true }),
      t({ id: 'second', actionable: true }),
      t({ id: 'third', actionable: true }),
    ]);
    expect(g[0].tasks.map((x) => x.id)).toEqual(['first', 'second', 'third']);
  });

  it('places in-progress before actionable (consistent order)', () => {
    const g = groupTasks([
      t({ id: 'b', actionable: true }),
      t({ id: 'a', claimedBy: 'agent' }),
    ]);
    expect(g.map((grp) => grp.kind)).toEqual(['in-progress', 'actionable']);
  });

  it('counts correctly: actionable filter excludes done', () => {
    const all = [
      t({ id: 'a', claimedBy: 'agent' }),
      t({ id: 'b', actionable: true }),
      t({ id: 'c', status: 'done' }),
    ];
    const g = groupTasks(all);
    // All groups present
    expect(g).toHaveLength(3);
    const actionableOnly = g.filter((grp) => grp.kind !== 'done');
    const n = actionableOnly.reduce((sum, grp) => sum + grp.tasks.length, 0);
    expect(n).toBe(2);
    expect(actionableOnly.map((grp) => grp.kind)).toEqual(['in-progress', 'actionable']);
  });

  it('exposes the canonical lifecycle order', () => {
    expect(LIFECYCLE_ORDER).toEqual(['in-progress', 'actionable', 'waiting-deps', 'blocked', 'done']);
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

  it('equals the sum of every non-done lifecycle group', () => {
    const all = [
      t({ id: 'a', claimedBy: 'agent' }),
      t({ id: 'b', actionable: true }),
      t({ id: 'c', status: 'done' }),
    ];
    const nonDone = groupTasks(all)
      .filter((g) => g.kind !== 'done')
      .reduce((sum, g) => sum + g.tasks.length, 0);
    expect(actionableOpenCount(all)).toBe(nonDone);
  });

  it('empty input → 0', () => {
    expect(actionableOpenCount([])).toBe(0);
  });
});

describe('recentCompletedTasks', () => {
  const now = Date.parse('2026-07-30T17:00:00.000Z');

  it('keeps completed tasks within 24 hours and sorts newest first', () => {
    const result = recentCompletedTasks([
      t({ id: 'older', status: 'done', completedAt: new Date(now - 23 * 60 * 60 * 1000).toISOString() }),
      t({ id: 'newer', status: 'done', completedAt: new Date(now - 10 * 60 * 1000).toISOString() }),
      t({ id: 'boundary', status: 'done', completedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString() }),
    ], now);
    expect(result.map((task) => task.id)).toEqual(['newer', 'older', 'boundary']);
  });

  it('excludes open, stale, future, missing, and invalid completion times', () => {
    const result = recentCompletedTasks([
      t({ id: 'open', completedAt: new Date(now - 1000).toISOString() }),
      t({ id: 'stale', status: 'done', completedAt: new Date(now - 24 * 60 * 60 * 1000 - 1).toISOString() }),
      t({ id: 'future', status: 'done', completedAt: new Date(now + 1).toISOString() }),
      t({ id: 'missing', status: 'done' }),
      t({ id: 'invalid', status: 'done', completedAt: 'not-a-date' }),
    ], now);
    expect(result).toEqual([]);
  });

  it('keeps legacy date-only values through the end of their UTC calendar day', () => {
    const result = recentCompletedTasks([
      t({ id: 'today', status: 'done', completedAt: '2026-07-30' }),
      t({ id: 'yesterday', status: 'done', completedAt: '2026-07-29' }),
      t({ id: 'older', status: 'done', completedAt: '2026-07-28' }),
    ], now);
    expect(result.map((task) => task.id)).toEqual(['today', 'yesterday']);
  });
});
