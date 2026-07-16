import { describe, it, expect } from 'vitest';
import type { ThreadInfo, ThreadDetail, ThreadStepDetail, ThreadChildNode } from '@cortex-agent/ui-contract';
import {
  threadsBudgetBand,
  threadCardKind,
  pipelineSteps,
  runningMeta,
  waitingMeta,
  activeSegmentLabel,
} from './m-threads-vm';

// Neutral fixtures (守则11 — nimbus/atlas, no real project ids).
function info(over: Partial<ThreadInfo>): ThreadInfo {
  return {
    id: 'thr_1a2b',
    templateName: 'experiment-pipeline',
    currentStep: { index: 2, name: 'review' },
    status: 'running',
    projectId: 'nimbus',
    createdAt: '2026-07-15T11:18:00Z',
    updatedAt: '2026-07-15T12:00:00Z',
    totalSteps: 4,
    artifactPath: null,
    ...over,
  };
}

function step(over: Partial<ThreadStepDetail>): ThreadStepDetail {
  return {
    stepIndex: 0,
    agentSlotId: 'a0',
    stage: null,
    status: 'pending',
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

function child(over: Partial<ThreadChildNode>): ThreadChildNode {
  return {
    id: 'thr_child',
    templateName: 'verify-metrics',
    status: 'running',
    activeAgent: null,
    costUsd: 0,
    depth: 1,
    createdAt: '2026-07-15T11:40:00Z',
    taskId: null,
    children: [],
    truncated: false,
    ...over,
  };
}

function detail(over: Partial<ThreadDetail>): ThreadDetail {
  return {
    id: 'thr_1a2b',
    templateName: 'experiment-pipeline',
    currentStep: { index: 2, name: 'review' },
    status: 'running',
    projectId: 'nimbus',
    createdAt: '2026-07-15T11:18:00Z',
    updatedAt: '2026-07-15T12:00:00Z',
    totalSteps: 4,
    artifactPath: null,
    endedAt: null,
    error: null,
    abortReason: null,
    activeAgent: null,
    activeStage: null,
    totalCostUsd: 2.31,
    steps: [],
    agentFlow: null,
    dispatches: [],
    children: [],
    artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
    ...over,
  };
}

const now = Date.parse('2026-07-15T12:00:00Z');

describe('threadsBudgetBand', () => {
  it('real today / real dailyBudget → filled percentage', () => {
    expect(threadsBudgetBand(4.21, 10)).toEqual({ numerator: '$4.21', denominator: '$10.00', pct: 42.1 });
  });
  it('no dailyBudget → honest — denominator + empty bar (no fabricated $10.00)', () => {
    expect(threadsBudgetBand(4.21, 0)).toEqual({ numerator: '$4.21', denominator: '—', pct: 0 });
    expect(threadsBudgetBand(4.21, undefined)).toEqual({ numerator: '$4.21', denominator: '—', pct: 0 });
  });
  it('no today → — numerator', () => {
    expect(threadsBudgetBand(undefined, 10).numerator).toBe('—');
  });
  it('clamps overrun to 100%', () => {
    expect(threadsBudgetBand(30, 10).pct).toBe(100);
  });
});

describe('threadCardKind', () => {
  it('waiting → the amber approval card', () => {
    expect(threadCardKind('waiting')).toBe('waiting');
  });
  it('running (and everything else) → the running pipeline card', () => {
    expect(threadCardKind('running')).toBe('running');
    expect(threadCardKind('completed')).toBe('running');
  });
});

describe('pipelineSteps', () => {
  it('prefers real detail stages + statuses', () => {
    const steps = pipelineSteps(
      info({}),
      detail({
        steps: [
          step({ stepIndex: 0, stage: 'plan', status: 'completed' }),
          step({ stepIndex: 1, stage: 'execute', status: 'completed' }),
          step({ stepIndex: 2, stage: 'review', status: 'running' }),
          step({ stepIndex: 3, stage: 'submit', status: 'pending' }),
        ],
      }),
    );
    expect(steps).toEqual([
      { label: 'plan', state: 'done' },
      { label: 'execute', state: 'done' },
      { label: 'review', state: 'active' },
      { label: 'submit', state: 'pending' },
    ]);
  });
  it('falls back to the list summary (index vs currentStep) when detail is absent', () => {
    const steps = pipelineSteps(info({ totalSteps: 4, currentStep: { index: 2, name: 'review' } }));
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'active', 'pending']);
    expect(steps[2].label).toBe('review');
  });
  it('empty when there are no steps at all', () => {
    expect(pipelineSteps(info({ totalSteps: 0, currentStep: null }))).toEqual([]);
  });
});

describe('runningMeta', () => {
  it('id + age always; cost + child count once detail loads', () => {
    expect(runningMeta(info({}), detail({ totalCostUsd: 2.31, children: [child({}), child({ id: 'c2' })] }), now, '子线程'))
      .toBe('thr_1a2b · 42m · $2.31 · 2 子线程');
  });
  it('omits cost / children before the detail loads (no fabrication)', () => {
    expect(runningMeta(info({}), undefined, now, '子线程')).toBe('thr_1a2b · 42m');
  });
  it('omits the child count when there are none', () => {
    expect(runningMeta(info({}), detail({ totalCostUsd: 0.1, children: [] }), now, '子线程')).toBe('thr_1a2b · 42m · $0.10');
  });
});

describe('waitingMeta', () => {
  it('renders only the real id + age (dispatch 暂停 / 超预算 are mocks)', () => {
    expect(waitingMeta(info({ id: 'thr_a41d', status: 'waiting' }), now)).toBe('thr_a41d · 42m');
  });
});

describe('activeSegmentLabel', () => {
  it('appends the real active count', () => {
    expect(activeSegmentLabel('活跃', 3)).toBe('活跃 3');
  });
});
