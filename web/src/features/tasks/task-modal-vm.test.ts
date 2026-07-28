// input:  task lifecycle, dependency graph, and claim state
// output: semantic task-modal status, dependency, and action models
// pos:    Pure task-modal behavior tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { TaskInfo } from '@cortex-agent/ui-contract';
import { buildTaskModalVm } from './task-modal-vm';

function task(partial: Partial<TaskInfo>): TaskInfo {
  return {
    id: 'T-100',
    text: 'a task',
    project: 'proj',
    status: 'open',
    priority: 'medium',
    actionable: false,
    claimedBy: null,
    blockedBy: null,
    dependsOn: [],
    plan: null,
    template: 'experiment-pipeline',
    why: null,
    doneWhen: null,
    ...partial,
  };
}

function fieldValue(t: TaskInfo, key: string): string | undefined {
  return buildTaskModalVm(t, []).fields.find((field) => field.k === key)?.v;
}

describe('buildTaskModalVm status precedence', () => {
  it.each([
    [task({ status: 'done', blockedBy: 'T-1', claimedBy: 'thr_x', actionable: true }), 'done'],
    [task({ blockedBy: 'T-1', claimedBy: 'thr_x', actionable: true }), 'blocked'],
    [task({ claimedBy: 'thr_x', actionable: true }), 'in-progress'],
    [task({ actionable: true }), 'actionable'],
    [task({}), 'waiting'],
  ])('derives %s as %s', (input, expected) => {
    expect(fieldValue(input, 'status')).toBe(expected);
  });
});

describe('buildTaskModalVm dependency joins', () => {
  it('resolves upstream task data and completion state', () => {
    const current = task({ id: 'T-044', dependsOn: ['T-041'] });
    const upstream = task({ id: 'T-041', text: 'DR sweep', status: 'done' });

    expect(buildTaskModalVm(current, [current, upstream]).deps).toEqual([
      expect.objectContaining({ id: 'T-041', name: 'DR sweep', label: 'upstream · done' }),
    ]);
  });

  it('discovers downstream dependants by reverse lookup', () => {
    const current = task({ id: 'T-041' });
    const downstream = task({ id: 'T-044', text: 'analyze sweep', dependsOn: ['T-041'] });

    expect(buildTaskModalVm(current, [current, downstream]).deps).toEqual([
      expect.objectContaining({ id: 'T-044', name: 'analyze sweep', label: 'downstream' }),
    ]);
  });

  it('keeps an unresolved upstream id visible', () => {
    const current = task({ id: 'T-044', dependsOn: ['T-999'] });
    expect(buildTaskModalVm(current, [current]).deps).toEqual([
      expect.objectContaining({ id: 'T-999', name: '—', label: 'upstream' }),
    ]);
  });
});

describe('buildTaskModalVm action guards', () => {
  it('allows unblock only for explicitly blocked tasks', () => {
    expect(buildTaskModalVm(task({ blockedBy: 'T-1' }), []).canUnblock).toBe(true);
    expect(buildTaskModalVm(task({}), []).canUnblock).toBe(false);
  });

  it('allows completion only before done and while unblocked', () => {
    expect(buildTaskModalVm(task({}), []).completable).toBe(true);
    expect(buildTaskModalVm(task({ status: 'done' }), []).completable).toBe(false);
    expect(buildTaskModalVm(task({ blockedBy: 'T-1' }), []).completable).toBe(false);
  });
});
