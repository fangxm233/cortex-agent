import { describe, it, expect } from 'vitest';
import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
} from '@cortex-agent/ui-contract';
import { threadPill, buildThreadCard } from './thread-card-proto';

function step(p: Partial<ThreadStepDetail> & { stepIndex: number }): ThreadStepDetail {
  return {
    stepIndex: p.stepIndex,
    agentSlotId: p.agentSlotId ?? `slot-${p.stepIndex}`,
    stage: p.stage ?? null,
    status: p.status ?? 'completed',
    executionId: p.executionId ?? null,
    sessionId: p.sessionId ?? null,
    sessionName: p.sessionName ?? null,
    costUsd: p.costUsd ?? null,
    numTurns: p.numTurns ?? null,
    durationS: p.durationS ?? null,
    startedAt: p.startedAt ?? null,
    endedAt: p.endedAt ?? null,
    outputSummary: p.outputSummary ?? null,
  };
}

function child(p: Partial<ThreadChildNode> & { id: string }): ThreadChildNode {
  return {
    id: p.id,
    templateName: p.templateName ?? null,
    status: p.status ?? 'running',
    activeAgent: p.activeAgent ?? null,
    costUsd: p.costUsd ?? 0,
    depth: p.depth ?? 0,
    createdAt: p.createdAt ?? '2026-07-06T00:00:00.000Z',
    taskId: p.taskId ?? null,
    children: p.children ?? [],
    truncated: p.truncated ?? false,
  };
}

function detail(p: Partial<ThreadDetail>): ThreadDetail {
  return {
    id: p.id ?? 'thr_test',
    templateName: p.templateName ?? 'experiment-pipeline',
    currentStep: p.currentStep ?? null,
    status: p.status ?? 'running',
    projectId: p.projectId ?? 'proj',
    createdAt: p.createdAt ?? '2026-07-06T00:00:00.000Z',
    updatedAt: p.updatedAt ?? '2026-07-06T00:00:00.000Z',
    totalSteps: p.totalSteps ?? (p.steps?.length ?? 0),
    artifactPath: p.artifactPath ?? null,
    endedAt: p.endedAt ?? null,
    error: p.error ?? null,
    abortReason: p.abortReason ?? null,
    activeAgent: p.activeAgent ?? null,
    activeStage: p.activeStage ?? null,
    totalCostUsd: p.totalCostUsd ?? 0,
    steps: p.steps ?? [],
    agentFlow: p.agentFlow ?? null,
    dispatches: p.dispatches ?? [],
    children: p.children ?? [],
    // ThreadArtifactRefs and any trailing fields are structurally optional for these pure tests
    ...(p as object),
  } as ThreadDetail;
}

describe('threadPill', () => {
  it.each([
    ['running', 'Running'],
    ['waiting', 'Waiting'],
    ['completed', 'Done'],
    ['failed', 'Failed'],
    ['cancelled', 'Cancelled'],
    ['aborted', 'Cancelled'],
  ] as const)('maps %s to its semantic label', (status, label) => {
    expect(threadPill(status).text).toBe(label);
  });
});

describe('buildThreadCard', () => {
  it('maps a completed/running/pending step sequence to node states, tails, chevrons', () => {
    const d = detail({
      id: 'thr_8f2c',
      templateName: 'experiment-pipeline',
      status: 'running',
      currentStep: { index: 1, name: 'Review' },
      totalSteps: 4,
      totalCostUsd: 2.52,
      steps: [
        step({ stepIndex: 0, stage: 'Plan', status: 'completed', costUsd: 0.04, durationS: 180 }),
        step({ stepIndex: 1, stage: 'Review', status: 'running', costUsd: 0.38, durationS: 252 }),
        step({ stepIndex: 2, stage: 'Commit', status: 'pending' }),
      ],
    });
    const card = buildThreadCard(d);
    expect(card.id).toBe('thr_8f2c');
    expect(card.name).toBe('experiment-pipeline');
    expect(card.pillText).toBe('Step 2/4');
    expect(card.rows).toHaveLength(3);

    expect(card.rows[0].node).toBe('done');
    expect(card.rows[0].chev).toBe(true);
    expect(card.rows[0].expanded).toBe(false);
    expect(card.rows[0].hasTail).toBe(true);

    expect(card.rows[1].node).toBe('running');
    expect(card.rows[1].expanded).toBe(true);
    expect(card.rows[1].fw).toBe(600);
    expect(card.rows[1].hasTail).toBe(true);

    expect(card.rows[2].node).toBe('pending');
    expect(card.rows[2].hasTail).toBe(false);
  });

  it('expands the active step children into sub-thread cards with L-levels + nested rows', () => {
    const d = detail({
      status: 'running',
      steps: [step({ stepIndex: 0, stage: 'Review', status: 'running' })],
      totalSteps: 1,
      currentStep: { index: 0, name: 'Review' },
      children: [
        child({
          id: 'thr_b7f3',
          templateName: 'verify-metrics',
          status: 'running',
          depth: 0,
          children: [child({ id: 'thr_c1', templateName: 'stats-audit', status: 'running', depth: 1 })],
        }),
      ],
    });
    const card = buildThreadCard(d);
    const active = card.rows[0];
    expect(active.node).toBe('running');
    expect(active.subs).toHaveLength(1);
    expect(active.subs[0].name).toBe('verify-metrics');
    expect(active.subs[0].level).toBe('L2');
    expect(active.subs[0].nested).not.toBeNull();
    expect(active.subs[0].nested?.name).toBe('stats-audit');
    expect(active.subs[0].nested?.level).toBe('L3');
    expect(active.subs[0].nested?.running).toBe(true);
  });

  it('leaves non-active steps with no expanded children', () => {
    const d = detail({
      status: 'completed',
      steps: [
        step({ stepIndex: 0, stage: 'Plan', status: 'completed' }),
        step({ stepIndex: 1, stage: 'Review', status: 'completed' }),
      ],
      totalSteps: 2,
      children: [child({ id: 'x', templateName: 'sub', depth: 0 })],
    });
    const card = buildThreadCard(d);
    expect(card.rows.every((r) => !r.expanded)).toBe(true);
    expect(card.rows.every((r) => r.subs.length === 0)).toBe(true);
  });
});
