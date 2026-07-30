// input:  grouped task fixtures and mobile segment model
// output: executable/recent/all group regressions
// pos:    Mobile task view-model unit tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { groupMobileTasks } from '@/mobile/mobile-tasks';
import { buildMTaskGroups } from './m-tasks-vm';

// Neutral placeholder tasks (守则11 — no real project names / ids).
function task(over: Partial<TaskInfo>): TaskInfo {
  return {
    id: 'T-000',
    text: 'a task',
    project: 'nimbus',
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

describe('buildMTaskGroups', () => {
  const grouped = groupMobileTasks([
    task({ id: 'A', claimedBy: 'thr_a' }), // in-progress
    task({ id: 'B', actionable: true }), // claimable
    task({ id: 'C', actionable: true }), // claimable
    task({ id: 'D', actionable: true, dependsOn: ['A'] }), // waiting-deps (A is open)
    task({ id: 'E', blockedBy: 'APR-0001' }), // blocked
    task({ id: 'F', status: 'done' }), // done
  ]);

  it('all: 进行中 → 可执行 → 阻塞 → 完成 order (waiting-deps is NEVER a 1d group)', () => {
    expect(buildMTaskGroups(grouped, 'all').map((g) => g.key)).toEqual([
      'in-progress',
      'claimable',
      'blocked',
      'done',
    ]);
  });

  it('executable: only 进行中 + 可执行 (blocked + done hidden)', () => {
    expect(buildMTaskGroups(grouped, 'executable').map((g) => g.key)).toEqual([
      'in-progress',
      'claimable',
    ]);
  });

  it('recent: only the prefiltered completed group', () => {
    expect(buildMTaskGroups(grouped, 'recent').map((g) => g.key)).toEqual(['done']);
  });

  it('carries done tasks onto the done group in the 全部 segment', () => {
    const views = buildMTaskGroups(grouped, 'all');
    expect(views.find((v) => v.key === 'done')?.tasks.map((t) => t.id)).toEqual(['F']);
  });

  it('carries the real tasks onto each group view', () => {
    const views = buildMTaskGroups(grouped, 'all');
    expect(views.find((v) => v.key === 'claimable')?.tasks.map((t) => t.id)).toEqual(['B', 'C']);
    expect(views.find((v) => v.key === 'blocked')?.tasks.map((t) => t.id)).toEqual(['E']);
  });

  it('drops empty groups', () => {
    const g = groupMobileTasks([task({ id: 'B', actionable: true })]);
    expect(buildMTaskGroups(g, 'all').map((v) => v.key)).toEqual(['claimable']);
  });
});
