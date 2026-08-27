// input:  task lifecycle, dependency graph, claim state, and completion evidence
// output: Desktop approval, stored-field, shared-fact, dependency, and action tests
// pos:    Desktop task-modal projection regression tests
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { TaskInfo, TaskVerificationInfo } from '@cortex-agent/ui-contract';
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

  it('shows the task template verbatim', () => {
    expect(fieldValue(task({ template: 'manager' }), 'template')).toBe('manager');
  });

  it('shows pending and completed approval state', () => {
    const pending = task({ approvalNeeded: true, approvedAt: null });
    expect(fieldValue(pending, 'approval-needed')).toBe('true');
    expect(fieldValue(pending, 'approved-at')).toBe('—');

    const approved = task({ approvalNeeded: false, approvedAt: '2026-07-30' });
    expect(fieldValue(approved, 'approval-needed')).toBe('false');
    expect(fieldValue(approved, 'approved-at')).toBe('2026-07-30');
  });

  it('uses approval-needed as the pending task pill before actionable', () => {
    const vm = buildTaskModalVm(task({ approvalNeeded: true, actionable: true }), []);
    expect(vm.pill.text).toBe('approval-needed');
  });

  it('prefers the owning thread id and safely falls back to a direct claim owner', () => {
    const claimed = task({ claimedBy: 'task-dispatcher', claimThreadId: 'thr_nimbus' });
    const vm = buildTaskModalVm(claimed, []);
    expect(fieldValue(claimed, 'claimed-by')).toBe('thr_nimbus');
    expect(vm.pill.text).toBe('● in-progress · thr_nimbus');

    const direct = task({ claimedBy: 'agent-a' });
    expect(fieldValue(direct, 'claimed-by')).toBe('agent-a');
  });

  it('uses verification completion evidence before stale list data', () => {
    const evidenceAt = '2030-01-02T12:00:00.000Z';
    const verification: TaskVerificationInfo = {
      taskId: 'T-100', project: 'proj',
      evidence: {
        doneWhen: null, completed: true, completedAt: evidenceAt, completedNote: null,
        completingExecutionId: null, completingOutput: null,
      },
      dispatches: [],
    };
    const vm = buildTaskModalVm(task({ completedAt: '2030-01-01T12:00:00.000Z' }), [], verification);
    expect(vm.fields.find((field) => field.k === 'completed-at')?.v).toContain('2030-01-02');
  });

  it('reports when the task has no dependencies', () => {
    expect(buildTaskModalVm(task({}), []).hasDependencies).toBe(false);
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
