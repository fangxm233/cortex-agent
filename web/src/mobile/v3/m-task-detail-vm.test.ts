import { describe, it, expect } from 'vitest';
import type { TaskInfo, TaskVerificationInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';
import { buildTaskDetailVm, formatElapsed } from './m-task-detail-vm';

function task(over: Partial<TaskInfo>): TaskInfo {
  return {
    id: '001',
    text: 'run DR sweep — friction ∈ [0.6, 1.2]',
    project: 'atlas',
    status: 'open',
    priority: 'high',
    actionable: false,
    claimedBy: null,
    blockedBy: null,
    dependsOn: [],
    plan: null,
    template: 'experiment-pipeline',
    why: null,
    doneWhen: 'report has 8 seed curves; ci95 on agent success',
    ...over,
  };
}

function dispatch(over: Partial<TaskDispatchRecord>): TaskDispatchRecord {
  return {
    executionId: 'exec_1',
    type: 'dispatch',
    status: 'running',
    machine: 'app-lab2',
    threadId: 'thr_nimbus',
    startedAt: '2026-07-15T11:18:00Z',
    finishedAt: null,
    durationMs: 42 * 60 * 1000,
    cost: 2.31,
    ...over,
  };
}

function verification(over: Partial<TaskVerificationInfo>): TaskVerificationInfo {
  return {
    taskId: '001',
    project: 'atlas',
    evidence: {
      doneWhen: null,
      completed: false,
      completedAt: null,
      completedNote: null,
      completingExecutionId: null,
      completingOutput: null,
    },
    dispatches: [],
    ...over,
  };
}

const NOW = Date.parse('2026-07-15T12:00:00Z');

describe('formatElapsed', () => {
  it('formats seconds / minutes / hours, null-safe', () => {
    expect(formatElapsed(null)).toBeNull();
    expect(formatElapsed(-5)).toBeNull();
    expect(formatElapsed(30_000)).toBe('30s');
    expect(formatElapsed(42 * 60 * 1000)).toBe('42m');
    expect(formatElapsed(2 * 3600 * 1000 + 3 * 60 * 1000)).toBe('2h 3m');
  });
});

describe('buildTaskDetailVm', () => {
  it('returns not-found when the id is absent from the list', () => {
    const vm = buildTaskDetailVm('zzzz', [task({})], null, NOW);
    expect(vm.found).toBe(false);
  });

  it('maps the real id, text, doneWhen and derives the in-progress status', () => {
    const vm = buildTaskDetailVm('001', [task({ claimedBy: 'exec_dispatch_x' })], null, NOW);
    expect(vm.found).toBe(true);
    expect(vm.displayId).toBe('T-001');
    expect(vm.text).toContain('DR sweep');
    expect(vm.doneWhen).toContain('8 seed curves');
    expect(vm.statusKind).toBe('in-progress');
  });

  it('derives blocked / done / actionable / waiting status kinds in precedence', () => {
    expect(buildTaskDetailVm('001', [task({ status: 'done', claimedBy: 'x' })], null, NOW).statusKind).toBe('done');
    expect(buildTaskDetailVm('001', [task({ blockedBy: 'gate' })], null, NOW).statusKind).toBe('blocked');
    expect(buildTaskDetailVm('001', [task({ actionable: true })], null, NOW).statusKind).toBe('actionable');
    expect(buildTaskDetailVm('001', [task({ actionable: false })], null, NOW).statusKind).toBe('waiting');
  });

  it('honest null done-when passthrough', () => {
    const vm = buildTaskDetailVm('001', [task({ doneWhen: null })], null, NOW);
    expect(vm.doneWhen).toBeNull();
  });

  it('builds a claim card only when claimed, with real thread id + elapsed·cost meta', () => {
    const claimed = task({ claimedBy: 'exec_dispatch_x' });
    const vm = buildTaskDetailVm('001', [claimed], verification({ dispatches: [dispatch({})] }), NOW);
    expect(vm.claim).not.toBeNull();
    expect(vm.claim!.template).toBe('experiment-pipeline');
    expect(vm.claim!.threadId).toBe('thr_nimbus');
    expect(vm.claim!.claimedBy).toBe('exec_dispatch_x');
    expect(vm.claim!.meta).toBe('42m · $2.31');
  });

  it('omits the claim card when unclaimed', () => {
    const vm = buildTaskDetailVm('001', [task({ claimedBy: null })], verification({ dispatches: [dispatch({})] }), NOW);
    expect(vm.claim).toBeNull();
  });

  it('claim meta omits fields with no source; threadId null when no dispatch carries one', () => {
    const claimed = task({ claimedBy: 'exec_dispatch_x' });
    const vm = buildTaskDetailVm(
      '001',
      [claimed],
      verification({ dispatches: [dispatch({ threadId: null, durationMs: null, cost: null })] }),
      NOW,
    );
    expect(vm.claim!.threadId).toBeNull();
    expect(vm.claim!.meta).toBeNull();
  });

  it('joins dependsOn against the list with each dep own status kind + known flag', () => {
    const dep = task({ id: '038', text: 'upstream', blockedBy: 'gate' });
    const vm = buildTaskDetailVm('001', [task({ dependsOn: ['038', 'ffff'] }), dep], null, NOW);
    expect(vm.deps).toHaveLength(2);
    expect(vm.deps[0]).toMatchObject({ displayId: 'T-038', statusKind: 'blocked', known: true });
    expect(vm.deps[1]).toMatchObject({ displayId: 'T-ffff', known: false });
  });

  it('history rows come from dispatches (newest first) with status/type/completing flags', () => {
    const claimed = task({ claimedBy: 'x' });
    const v = verification({
      evidence: { doneWhen: null, completed: true, completedAt: null, completedNote: null, completingExecutionId: 'exec_2', completingOutput: null },
      dispatches: [
        dispatch({ executionId: 'exec_2', status: 'completed', startedAt: '2026-07-15T11:50:00Z' }),
        dispatch({ executionId: 'exec_1', status: 'running', startedAt: '2026-07-14T09:00:00Z' }),
      ],
    });
    const vm = buildTaskDetailVm('001', [claimed], v, NOW);
    expect(vm.history).toHaveLength(2);
    expect(vm.history[0]).toMatchObject({ status: 'completed', type: 'dispatch', isCompleting: true });
    expect(vm.history[1]).toMatchObject({ status: 'running', isCompleting: false });
  });

  it('empty history when never dispatched', () => {
    const vm = buildTaskDetailVm('001', [task({})], verification({ dispatches: [] }), NOW);
    expect(vm.history).toEqual([]);
  });
});
