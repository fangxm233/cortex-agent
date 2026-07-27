// input:  thread detail DTO fixtures and step selectors
// output: thread-step selector regression tests
// pos:    Verifies active-step child and summary derivations
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadDispatchInfo,
  ThreadChildNode,
  ThreadAgentFlow,
} from '@cortex-agent/ui-contract';
import {
  selectActiveStep,
  dispatchesForStep,
  activeStepChildren,
  stepSummaryParts,
} from './thread-steps';

function step(partial: Partial<ThreadStepDetail>): ThreadStepDetail {
  return {
    stepIndex: 0,
    agentSlotId: 'slot-0',
    stage: null,
    status: 'completed',
    executionId: null,
    sessionId: null,
    sessionName: null,
    costUsd: null,
    numTurns: null,
    durationS: null,
    startedAt: null,
    endedAt: null,
    outputSummary: null,
    ...partial,
  };
}

function dispatch(partial: Partial<ThreadDispatchInfo>): ThreadDispatchInfo {
  return {
    executionId: 'exec-0',
    status: 'running',
    machine: null,
    type: 'dispatch',
    agentSlotId: null,
    stepIndex: null,
    taskId: null,
    runName: null,
    startedAt: '2026-07-06T00:00:00Z',
    finishedAt: null,
    durationMs: null,
    cost: null,
    ...partial,
  };
}

function child(partial: Partial<ThreadChildNode>): ThreadChildNode {
  return {
    id: 'thr_child',
    templateName: 'coder-review',
    status: 'running',
    activeAgent: null,
    costUsd: 0,
    depth: 1,
    createdAt: '2026-07-06T00:00:00Z',
    taskId: null,
    children: [],
    truncated: false,
    ...partial,
  };
}

const agentFlow: ThreadAgentFlow = {
  slotId: 'slot-1',
  profile: 'coder',
  status: 'running',
  stage: 'implement',
  sessionId: 'sess-1',
  sessionName: 'coder@1',
  lastOutput: 'working…',
};

function detail(partial: Partial<ThreadDetail>): ThreadDetail {
  return {
    id: 'thr_abc',
    templateName: 'coder-review',
    currentStep: { index: 1, name: 'implement' },
    status: 'running',
    projectId: 'cortex-self',
    createdAt: '2026-07-06T00:00:00Z',
    updatedAt: '2026-07-06T00:01:00Z',
    totalSteps: 3,
    artifactPath: null,
    endedAt: null,
    error: null,
    abortReason: null,
    activeAgent: 'slot-1',
    activeStage: 'implement',
    totalCostUsd: 0,
    steps: [],
    agentFlow: null,
    dispatches: [],
    subtasks: [],
    children: [],
    artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
    ...partial,
  };
}

describe('selectActiveStep', () => {
  it('returns the running step', () => {
    const s0 = step({ stepIndex: 0, status: 'completed' });
    const s1 = step({ stepIndex: 1, status: 'running', agentSlotId: 'slot-1' });
    const s2 = step({ stepIndex: 2, status: 'pending' });
    expect(selectActiveStep(detail({ steps: [s0, s1, s2] }))).toBe(s1);
  });

  it('returns null when no step is running (terminal thread)', () => {
    const s0 = step({ stepIndex: 0, status: 'completed' });
    const s1 = step({ stepIndex: 1, status: 'completed' });
    expect(selectActiveStep(detail({ status: 'completed', steps: [s0, s1] }))).toBeNull();
  });

  it('returns null for an empty step list', () => {
    expect(selectActiveStep(detail({ steps: [] }))).toBeNull();
  });
});

describe('dispatchesForStep', () => {
  it('joins by exact stepIndex when one agent slot serves multiple stages', () => {
    const plan = step({ stepIndex: 0, agentSlotId: 'coder', stage: 'plan' });
    const implement = step({ stepIndex: 1, agentSlotId: 'coder', stage: 'implement', status: 'running' });
    const planRun = dispatch({ executionId: 'e-plan', agentSlotId: 'coder', stepIndex: 0 });
    const implementRun = dispatch({ executionId: 'e-implement', agentSlotId: 'coder', stepIndex: 1 });
    const unlinked = dispatch({ executionId: 'e3', agentSlotId: null });
    const d = detail({ dispatches: [planRun, implementRun, unlinked] });
    expect(dispatchesForStep(d, plan)).toEqual([planRun]);
    expect(dispatchesForStep(d, implement)).toEqual([implementRun]);
  });
});

describe('activeStepChildren', () => {
  it('bundles matched dispatches + thread subthreads + agentFlow for the active step', () => {
    const s0 = step({ stepIndex: 0, status: 'completed', agentSlotId: 'slot-0' });
    const s1 = step({ stepIndex: 1, status: 'running', agentSlotId: 'slot-1' });
    const mine = dispatch({ executionId: 'e1', agentSlotId: 'slot-1', stepIndex: 1, machine: 'lab2' });
    const other = dispatch({ executionId: 'e2', agentSlotId: 'slot-0', stepIndex: 0 });
    const sub = child({ id: 'thr_sub' });
    const d = detail({
      steps: [s0, s1],
      dispatches: [mine, other],
      children: [sub],
      agentFlow,
    });
    expect(activeStepChildren(d)).toEqual({
      dispatches: [mine],
      subthreads: [sub],
      agentFlow,
    });
  });

  it('returns null when there is no active step', () => {
    const s0 = step({ stepIndex: 0, status: 'completed' });
    expect(activeStepChildren(detail({ status: 'completed', steps: [s0] }))).toBeNull();
  });
});

describe('stepSummaryParts', () => {
  it('formats stage, cost, and duration, dropping null fields', () => {
    const s = step({ stage: 'implement', costUsd: 2.639, durationS: 369 });
    expect(stepSummaryParts(s)).toEqual(['implement', '$2.64', '6m 9s']);
  });

  it('omits missing pieces and formats sub-minute durations in seconds', () => {
    const s = step({ stage: null, costUsd: null, durationS: 42 });
    expect(stepSummaryParts(s)).toEqual(['42s']);
  });

  it('rounds fractional duration seconds (real threads.get emits floats)', () => {
    expect(stepSummaryParts(step({ durationS: 206.807 }))).toEqual(['3m 27s']);
    expect(stepSummaryParts(step({ durationS: 41.4 }))).toEqual(['41s']);
  });

  it('returns an empty array when nothing is available', () => {
    expect(stepSummaryParts(step({}))).toEqual([]);
  });
});
