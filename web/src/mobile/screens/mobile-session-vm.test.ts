// input:  mobile session view models and thread DTO fixtures
// output: mobile session view-model regression tests
// pos:    Verifies legacy mobile session derivations
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, it, expect } from 'vitest';
import type { ThreadDetail } from '@cortex-agent/ui-contract';
import { zhDivider, buildMobileStepper, toolChips } from './mobile-session-vm';

// Pure view-model for the mobile session screen 5a (scheme.dc.html L2932-3003, task c880). Real
// data is the only variable; every measurement lives in the presentational components. Neutral test
// fixtures (守则11 — no private project/exp names).

describe('zhDivider', () => {
  const now = new Date(2026, 6, 9, 10, 0); // 2026-07-09 10:00 local
  it('same calendar day → 今天 HH:MM', () => {
    const ts = new Date(2026, 6, 9, 7, 42).toISOString();
    expect(zhDivider(ts, now)).toBe('今天 07:42');
  });
  it('previous day → 昨天 HH:MM', () => {
    const ts = new Date(2026, 6, 8, 23, 5).toISOString();
    expect(zhDivider(ts, now)).toBe('昨天 23:05');
  });
  it('older → M月D日 HH:MM', () => {
    const ts = new Date(2026, 6, 3, 9, 8).toISOString();
    expect(zhDivider(ts, now)).toBe('7月3日 09:08');
  });
});

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
  it('pill text = current step name + index/total while running', () => {
    expect(buildMobileStepper(detail()).pillText).toBe('review 3/4');
  });
  it('footer = elapsed · cost · N subthreads (real children count)', () => {
    const s = buildMobileStepper(detail());
    expect(s.footer.elapsed).toBe('42m');
    expect(s.footer.cost).toBe('$2.31');
    expect(s.footer.subCount).toBe(2);
  });
  it('empty steps → no nodes, no crash', () => {
    const s = buildMobileStepper(detail({ steps: [], currentStep: null, totalSteps: 0 }));
    expect(s.nodes).toEqual([]);
  });
});

describe('toolChips', () => {
  const calls = [
    { kind: 'read', input: 'a' },
    { kind: 'threads.status', input: 'b' },
    { kind: 'grep', input: 'c' },
    { kind: 'edit', input: 'd' },
  ];

  it('uses the width-derived visible prefix instead of a fixed two-chip cap', () => {
    const chips = toolChips(calls, { visibleCount: 3, hiddenCount: 1 });
    expect(chips.names).toEqual(['read', 'threads.status', 'grep']);
    expect(chips.overflow).toBe(1);
  });

  it('can show fewer chips on a narrower row', () => {
    expect(toolChips(calls, { visibleCount: 1, hiddenCount: 3 })).toEqual({
      names: ['read'],
      overflow: 3,
    });
  });

  it('returns every name when the row fits', () => {
    expect(toolChips(calls, { visibleCount: 4, hiddenCount: 0 })).toEqual({
      names: ['read', 'threads.status', 'grep', 'edit'],
      overflow: 0,
    });
  });
});
