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
    claimThreadId: null,
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

describe('buildTaskModalVm persisted fields', () => {
  it('shows the stored status instead of the derived runtime state', () => {
    const open = task({ status: 'open', blockedBy: 'T-1', claimedBy: 'thr_x', actionable: true });
    expect(fieldValue(open, 'status')).toBe('open');
    expect(fieldValue(task({ status: 'done' }), 'status')).toBe('done');
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
