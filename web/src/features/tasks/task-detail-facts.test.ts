// input:  task list and verification fixtures with conflicting lifecycle and ordering data
// output: locale- and CSS-free status, claim, completion, dependency, and dispatch regressions
// pos:    Shared desktop/mobile task detail semantics specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type { TaskDispatchRecord, TaskInfo, TaskVerificationInfo } from '@cortex-agent/ui-contract';
import {
  buildTaskDetailFacts,
  buildTaskVerificationFacts,
  taskDetailStatusKind,
} from './task-detail-facts';

function task(over: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id: '100', text: 'current task', project: 'atlas', status: 'open', priority: 'medium',
    actionable: false, claimedBy: null, claimThreadId: null, blockedBy: null, dependsOn: [],
    plan: null, template: 'coder-review', why: null, doneWhen: null, ...over,
  };
}

function dispatch(over: Partial<TaskDispatchRecord> = {}): TaskDispatchRecord {
  return {
    executionId: 'exec-a', type: 'dispatch', status: 'running', machine: null,
    threadId: null, startedAt: '2030-01-01T00:00:00.000Z', finishedAt: null,
    durationMs: null, cost: null, ...over,
  };
}

function verification(over: Partial<TaskVerificationInfo> = {}): TaskVerificationInfo {
  return {
    taskId: '100', project: 'atlas',
    evidence: {
      doneWhen: null, completed: false, completedAt: null, completedNote: null,
      completingExecutionId: null, completingOutput: null,
    },
    dispatches: [], ...over,
  };
}

describe('task detail facts', () => {
  it('uses done, blocked, claimed, approval, actionable, then waiting status precedence', () => {
    const all = task({
      status: 'done', blockedBy: 'gate', claimedBy: 'agent-a', approvalNeeded: true,
      actionable: true,
    });
    expect(taskDetailStatusKind(all)).toBe('done');
    expect(taskDetailStatusKind(task({ blockedBy: 'gate', claimedBy: 'agent-a', approvalNeeded: true, actionable: true }))).toBe('blocked');
    expect(taskDetailStatusKind(task({ claimedBy: 'agent-a', approvalNeeded: true, actionable: true }))).toBe('in-progress');
    expect(taskDetailStatusKind(task({ approvalNeeded: true, actionable: true }))).toBe('approval-needed');
    expect(taskDetailStatusKind(task({ actionable: true }))).toBe('actionable');
    expect(taskDetailStatusKind(task())).toBe('waiting');
  });

  it('prefers an owning thread and safely falls back to legacy thread or claim ids', () => {
    const owned = buildTaskDetailFacts(task({ claimedBy: 'task-dispatcher', claimThreadId: 'thr_owner' }), [], null);
    expect(owned.claim).toEqual({ claimed: true, id: null, threadId: 'thr_owner', displayId: 'thr_owner' });

    const legacy = buildTaskDetailFacts(task({ claimedBy: 'thr_legacy' }), [], null);
    expect(legacy.claim).toMatchObject({ id: 'thr_legacy', threadId: 'thr_legacy', displayId: 'thr_legacy' });

    const direct = buildTaskDetailFacts(task({ claimedBy: 'agent-a' }), [], null);
    expect(direct.claim).toMatchObject({ id: 'agent-a', threadId: null, displayId: 'agent-a' });
    expect(buildTaskDetailFacts(task({ claimedBy: 'task-dispatcher' }), [], null).claim?.displayId).toBeNull();
  });

  it('uses verification completedAt before list data, then falls back to the list', () => {
    const listAt = '2030-01-01T00:00:00.000Z';
    const evidenceAt = '2030-01-02T00:00:00.000Z';
    const evidence = verification({
      evidence: {
        doneWhen: null, completed: true, completedAt: evidenceAt, completedNote: null,
        completingExecutionId: null, completingOutput: null,
      },
    });
    expect(buildTaskDetailFacts(task({ completedAt: listAt }), [], evidence).completedAt).toBe(evidenceAt);
    expect(buildTaskDetailFacts(task({ completedAt: listAt }), [], null).completedAt).toBe(listAt);
  });

  it('joins known and unknown upstreams and discovers downstream tasks', () => {
    const current = task({ dependsOn: ['up', 'missing'] });
    const upstream = task({ id: 'up', text: 'known upstream', status: 'done' });
    const downstream = task({ id: 'down', text: 'known downstream', dependsOn: ['100'] });
    const facts = buildTaskDetailFacts(current, [current, upstream, downstream], null);

    expect(facts.upstream).toEqual([
      expect.objectContaining({ relation: 'upstream', id: 'up', known: true, task: upstream, statusKind: 'done' }),
      expect.objectContaining({ relation: 'upstream', id: 'missing', known: false, task: null, statusKind: null }),
    ]);
    expect(facts.downstream).toEqual([
      expect.objectContaining({ relation: 'downstream', id: 'down', known: true, task: downstream }),
    ]);
  });
});

describe('task verification facts', () => {
  it('sorts dispatches newest-first without mutation and identifies newest and completing executions', () => {
    const older = dispatch({ executionId: 'older', startedAt: '2030-01-01T00:00:00.000Z' });
    const newest = dispatch({ executionId: 'newest', status: 'completed', startedAt: '2030-01-03T00:00:00.000Z' });
    const middle = dispatch({ executionId: 'middle', startedAt: '2030-01-02T00:00:00.000Z' });
    const input = [older, newest, middle];
    const facts = buildTaskVerificationFacts(verification({
      evidence: {
        doneWhen: 'tests pass', completed: true, completedAt: null, completedNote: 'done',
        completingExecutionId: 'middle', completingOutput: null,
      },
      dispatches: input,
    }));

    expect(facts.dispatches.map((item) => item.dispatch.executionId)).toEqual(['newest', 'middle', 'older']);
    expect(input.map((item) => item.executionId)).toEqual(['older', 'newest', 'middle']);
    expect(facts.newestDispatch?.dispatch).toBe(newest);
    expect(facts.completingExecution?.dispatch).toBe(middle);
    expect(facts.completingExecution?.isCompleting).toBe(true);
    expect(facts.hasEvidence).toBe(true);
  });
});
