// input:  thread detail DTO fixtures and step selectors
// output: thread-step selector regression tests
// pos:    Verifies active-step child and summary derivations
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadDispatchInfo,
} from '@cortex-agent/ui-contract';
import {
  dispatchesForStep,
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
