// input:  thread detail DTO fixtures, timestamps, dispatches, and child trees
// output: locale- and CSS-free thread detail fact regressions
// pos:    Shared desktop/mobile thread detail semantics specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type {
  ThreadChildNode,
  ThreadDetail,
  ThreadDispatchInfo,
  ThreadStepDetail,
} from '@cortex-agent/ui-contract';
import { buildThreadDetailFacts, threadIsLive, threadStepKind } from './thread-detail-facts';

const T0 = Date.parse('2030-01-01T00:00:00.000Z');
const NOW = T0 + 252_900;

function step(over: Partial<ThreadStepDetail> = {}): ThreadStepDetail {
  return {
    stepIndex: 0, agentSlotId: 'slot-a', stage: null, status: 'pending', executionId: null,
    sessionId: null, sessionName: null, costUsd: null, numTurns: null, durationS: null,
    startedAt: null, endedAt: null, outputSummary: null, ...over,
  };
}

function dispatch(over: Partial<ThreadDispatchInfo> = {}): ThreadDispatchInfo {
  return {
    executionId: 'exec-a', status: 'running', machine: null, type: 'dispatch', agentSlotId: null,
    stepIndex: null, taskId: null, runName: null, startedAt: new Date(T0).toISOString(),
    finishedAt: null, durationMs: null, cost: null, ...over,
  };
}

function child(id: string, depth: number, children: ThreadChildNode[] = []): ThreadChildNode {
  return {
    id, templateName: id, status: 'running', activeAgent: null, costUsd: 0, depth,
    createdAt: new Date(T0).toISOString(), taskId: null, children, truncated: false,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    id: 'thr-a', templateName: 'pipeline', currentStep: null, status: 'running', projectId: 'sample',
    createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), totalSteps: 0,
    artifactPath: null, endedAt: null, error: null, abortReason: null, activeAgent: null,
    activeStage: null, totalCostUsd: 0, steps: [], agentFlow: null, dispatches: [], subtasks: [],
    children: [], artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
    ...over,
  };
}

describe('thread detail facts', () => {
  it('classifies live thread states and every step kind without presentation copy', () => {
    const statuses: ThreadDetail['status'][] = ['running', 'waiting', 'completed'];
    expect(statuses.map(threadIsLive)).toEqual([true, true, false]);
    expect([
      step({ status: 'completed' }), step({ status: 'running' }), step({ status: 'pending' }),
    ].map(threadStepKind)).toEqual(['done', 'running', 'pending']);
  });

  it('derives clamped integer thread and active-step elapsed seconds', () => {
    const facts = buildThreadDetailFacts(detail({
      createdAt: new Date(T0).toISOString(),
      steps: [step({
        status: 'running', startedAt: new Date(T0 + 125_000).toISOString(), durationS: 127.9,
      })],
    }), NOW);
    expect(facts.elapsedSeconds).toBe(252);
    expect(facts.steps[0].elapsedSeconds).toBe(127);
    expect(facts.steps[0].durationSeconds).toBe(127.9);

    const terminal = buildThreadDetailFacts(detail({
      status: 'completed', endedAt: new Date(T0 + 60_000).toISOString(),
    }), NOW);
    expect(terminal.elapsedSeconds).toBe(60);
  });

  it('uses agent-flow, active-agent, then active-slot precedence for profile and output', () => {
    const active = step({ status: 'running', agentSlotId: 'slot-fallback', outputSummary: 'step output' });
    const withFlow = buildThreadDetailFacts(detail({
      activeAgent: 'thread-agent', steps: [active],
      agentFlow: {
        slotId: 'slot-flow', profile: 'flow-profile', status: 'running', stage: null,
        sessionId: null, sessionName: null, lastOutput: 'flow output',
      },
    }), NOW);
    expect([withFlow.activeProfile, withFlow.activeOutput]).toEqual(['flow-profile', 'flow output']);

    const withAgent = buildThreadDetailFacts(detail({ activeAgent: 'thread-agent', steps: [active] }), NOW);
    expect([withAgent.activeProfile, withAgent.activeOutput]).toEqual(['thread-agent', 'step output']);

    const withSlot = buildThreadDetailFacts(detail({ steps: [active] }), NOW);
    expect([withSlot.activeProfile, withSlot.activeOutput]).toEqual(['slot-fallback', 'step output']);
  });

  it('joins dispatches by exact step index and chooses active machine before thread fallback', () => {
    const active = step({ stepIndex: 2, status: 'running' });
    const facts = buildThreadDetailFacts(detail({
      steps: [active],
      dispatches: [
        dispatch({ executionId: 'wrong', stepIndex: 1, machine: 'fallback-node' }),
        dispatch({ executionId: 'exact-null', stepIndex: 2 }),
        dispatch({ executionId: 'exact-node', stepIndex: 2, machine: 'active-node' }),
      ],
    }), NOW);
    expect(facts.steps[0].dispatch?.executionId).toBe('exact-null');
    expect(facts.steps[0].machine).toBe('active-node');
    expect(facts.machine).toBe('active-node');
  });

  it('provides one bounded tree-depth fact for both surfaces', () => {
    const facts = buildThreadDetailFacts(detail({
      children: [child('a', 0, [child('b', 1, [child('c', 2)])])],
    }), NOW);
    expect(facts.depth).toEqual({ level: 4, limit: 5 });
  });
});
