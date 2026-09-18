import { describe, it, expect } from 'vitest';
import type { TaskInfo, TaskVerificationInfo, TaskDispatchRecord } from '@cortex-agent/ui-contract';
import { buildTaskDetailVm } from './m-task-detail-vm';

function task(over: Partial<TaskInfo>): TaskInfo {
  return {
    id: '001',
    text: 'run DR sweep — friction ∈ [0.6, 1.2]',
    project: 'atlas',
    status: 'open',
    priority: 'high',
    actionable: false,
    claimedBy: null,
    claimThreadId: null,
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

describe('buildTaskDetailVm', () => {
  it('returns not-found when the id is absent from the list', () => {
    const vm = buildTaskDetailVm('zzzz', [task({})], null, NOW);
    expect(vm.found).toBe(false);
  });

  it('derives blocked / done / approval / actionable / waiting status kinds in precedence', () => {
    expect(buildTaskDetailVm('001', [task({ status: 'done', claimedBy: 'x' })], null, NOW).statusKind).toBe('done');
    expect(buildTaskDetailVm('001', [task({ blockedBy: 'gate' })], null, NOW).statusKind).toBe('blocked');
    expect(buildTaskDetailVm('001', [task({ approvalNeeded: true, actionable: true })], null, NOW).statusKind).toBe('approval-needed');
    expect(buildTaskDetailVm('001', [task({ actionable: true })], null, NOW).statusKind).toBe('actionable');
    expect(buildTaskDetailVm('001', [task({ actionable: false })], null, NOW).statusKind).toBe('waiting');
  });

  it('uses verification completion time before the list and falls back to list data', () => {
    const listAt = '2026-08-03T20:22:33.000Z';
    const evidenceAt = '2026-08-04T20:22:33.000Z';
    const done = task({ status: 'done', completedAt: listAt });
    expect(buildTaskDetailVm('001', [done], null, NOW).completedAt).toBe(listAt);

    const evidence = verification({
      evidence: {
        doneWhen: null,
        completed: true,
        completedAt: evidenceAt,
        completedNote: null,
        completingExecutionId: null,
        completingOutput: null,
      },
    });
    expect(buildTaskDetailVm('001', [done], evidence, NOW).completedAt).toBe(evidenceAt);
    expect(buildTaskDetailVm('001', [task({})], null, NOW).completedAt).toBeNull();
  });

  it('prefers the tasks.list owning thread over dispatch-history and persisted owner ids', () => {
    const claimed = task({ claimedBy: 'task-dispatcher', claimThreadId: 'thr_owner' });
    const vm = buildTaskDetailVm('001', [claimed], verification({ dispatches: [dispatch({})] }), NOW);
    expect(vm.claim).not.toBeNull();
    expect(vm.claim!.template).toBe('experiment-pipeline');
    expect(vm.claim!.threadId).toBe('thr_owner');
    expect(vm.claim!.claimedBy).toBeNull();
  });

  it('uses a safe direct claim id but never an arbitrary history thread as the current owner', () => {
    const direct = buildTaskDetailVm('001', [task({ claimedBy: 'agent-a' })], null, NOW);
    expect(direct.claim).toMatchObject({ threadId: null, claimedBy: 'agent-a' });

    const claimed = task({ claimedBy: 'task-dispatcher' });
    const vm = buildTaskDetailVm('001', [claimed], verification({ dispatches: [dispatch({})] }), NOW);
    expect(vm.claim!.threadId).toBeNull();
    expect(vm.claim!.claimedBy).toBeNull();
  });

  it('omits the claim card when unclaimed', () => {
    const vm = buildTaskDetailVm('001', [task({ claimedBy: null })], verification({ dispatches: [dispatch({})] }), NOW);
    expect(vm.claim).toBeNull();
  });

  it('claim meta omits fields with no source and never exposes task-dispatcher', () => {
    const claimed = task({ claimedBy: 'task-dispatcher' });
    const vm = buildTaskDetailVm(
      '001',
      [claimed],
      verification({ dispatches: [dispatch({ threadId: null, durationMs: null, cost: null })] }),
      NOW,
    );
    expect(vm.claim!.threadId).toBeNull();
    expect(vm.claim!.claimedBy).toBeNull();
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
        dispatch({ executionId: 'exec_1', status: 'running', startedAt: '2026-07-14T09:00:00Z' }),
        dispatch({ executionId: 'exec_2', status: 'completed', startedAt: '2026-07-15T11:50:00Z' }),
      ],
    });
    const vm = buildTaskDetailVm('001', [claimed], v, NOW);
    expect(vm.history).toHaveLength(2);
    expect(vm.history[0]).toMatchObject({ status: 'completed', type: 'dispatch', isCompleting: true });
    expect(vm.history[1]).toMatchObject({ status: 'running', isCompleting: false });
  });
});
