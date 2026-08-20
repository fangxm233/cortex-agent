// input:  mobile thread-stepper view model and thread DTO fixtures
// output: step state, connector, and child-count regressions
// pos:    Verifies legacy mobile thread-stepper derivation
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { buildMobileStepper } from './mobile-session-vm';

// Pure view-model for the mobile session screen 5a (scheme.dc.html L2932-3003, task c880). Real
// data is the only variable; every measurement lives in the presentational components. Neutral test
// fixtures (守则11 — no private project/exp names).

function step(over: Partial<ThreadDetail['steps'][number]> = {}): ThreadDetail['steps'][number] {
  return {
    stepIndex: 0,
    agentSlotId: 'a0',
    stage: 'plan',
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
    ...over,
  };
}

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    id: 'thr_abcd',
    templateName: 'experiment-pipeline',
    currentStep: { index: 2, name: 'review' },
    status: 'running',
    projectId: 'nimbus',
    createdAt: new Date(2026, 6, 9, 9, 0).toISOString(),
    updatedAt: new Date(2026, 6, 9, 9, 42).toISOString(),
    totalSteps: 4,
    artifactPath: null,
    endedAt: null,
    error: null,
    abortReason: null,
    activeAgent: 'a2',
    activeStage: 'review',
    totalCostUsd: 2.31,
    steps: [
      step({ stepIndex: 0, stage: 'plan', status: 'completed' }),
      step({ stepIndex: 1, stage: 'execute', status: 'completed' }),
      step({ stepIndex: 2, stage: 'review', status: 'running' }),
      step({ stepIndex: 3, stage: 'commit', status: 'pending' }),
    ],
    agentFlow: null,
    dispatches: [],
    subtasks: [],
    children: [
      {
        id: 'thr_c1',
        templateName: 'verify-metrics',
        status: 'running',
        activeAgent: null,
        costUsd: 0,
        depth: 1,
        createdAt: new Date().toISOString(),
        taskId: null,
        children: [],
        truncated: false,
      },
      {
        id: 'thr_c2',
        templateName: 'verify-claims',
        status: 'completed',
        activeAgent: null,
        costUsd: 0,
        depth: 1,
        createdAt: new Date().toISOString(),
        taskId: null,
        children: [],
        truncated: false,
      },
    ],
    artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
    ...over,
  };
}

describe('buildMobileStepper', () => {
  it('maps each step to a node with its state and real label', () => {
    const s = buildMobileStepper(detail());
    expect(s.nodes.map((n) => n.label)).toEqual(['plan', 'execute', 'review', 'commit']);
    expect(s.nodes.map((n) => n.state)).toEqual(['done', 'done', 'running', 'pending']);
  });
  it('a line is done only when the node before it completed', () => {
    // 4 nodes → 3 connecting lines; between plan→execute (done), execute→review (done), review→commit (pending)
    const s = buildMobileStepper(detail());
    expect(s.nodes.slice(1).map((n) => n.lineDone)).toEqual([true, true, false]);
  });
  it('carries the real child count into the footer state', () => {
    expect(buildMobileStepper(detail()).footer.subCount).toBe(2);
  });
  it('empty steps → no nodes, no crash', () => {
    const s = buildMobileStepper(detail({ steps: [], currentStep: null, totalSteps: 0 }));
    expect(s.nodes).toEqual([]);
  });
});
