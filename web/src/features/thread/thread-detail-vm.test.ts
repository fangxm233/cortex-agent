import { describe, it, expect } from 'vitest';
import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
  ThreadDispatchInfo,
} from '@cortex-agent/ui-contract';
import { buildThreadDetailVm } from './thread-detail-vm';

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

function dispatch(p: Partial<ThreadDispatchInfo> & { executionId: string }): ThreadDispatchInfo {
  return {
    executionId: p.executionId,
    status: p.status ?? 'running',
    machine: p.machine ?? null,
    type: p.type ?? 'local',
    agentSlotId: p.agentSlotId ?? null,
    stepIndex: p.stepIndex ?? null,
    taskId: p.taskId ?? null,
    runName: p.runName ?? null,
    startedAt: p.startedAt ?? '2026-07-06T00:00:00.000Z',
    finishedAt: p.finishedAt ?? null,
    durationMs: p.durationMs ?? null,
    cost: p.cost ?? null,
  };
}

function detail(p: Partial<ThreadDetail>): ThreadDetail {
  return {
    id: p.id ?? 'thr_test',
    templateName: p.templateName ?? 'experiment-pipeline',
    currentStep: p.currentStep ?? null,
    status: p.status ?? 'running',
    projectId: p.projectId ?? 'quad-nav-sim2real',
    createdAt: p.createdAt ?? '2026-07-06T00:00:00.000Z',
    updatedAt: p.updatedAt ?? '2026-07-06T00:00:00.000Z',
    totalSteps: p.totalSteps ?? p.steps?.length ?? 0,
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
    subtasks: p.subtasks ?? [],
    children: p.children ?? [],
    artifacts: p.artifacts ?? {
      artifactPath: null,
      workspacePath: null,
      taskId: null,
      taskProject: null,
    },
  } as ThreadDetail;
}

const NOW = Date.parse('2026-07-06T00:42:18.000Z');

describe('buildThreadDetailVm', () => {
  const expDetail = detail({
    id: 'thr_8f2c',
    templateName: 'plan-exec-review',
    status: 'running',
    currentStep: { index: 2, name: 'Review' },
    totalSteps: 4,
    totalCostUsd: 2.52,
    createdAt: '2026-07-06T00:00:00.000Z',
    activeAgent: 'reviewer',
    activeStage: 'Review',
    agentFlow: {
      slotId: 'slot-2',
      profile: 'reviewer',
      status: 'running',
      stage: 'Review',
      sessionId: 's',
      sessionName: 'sess',
      lastOutput: 'Now checking the headline claim.',
    },
    steps: [
      step({ stepIndex: 0, stage: 'Plan', status: 'completed', costUsd: 0.04, durationS: 180, outputSummary: 'plan.md', sessionId: 'cortex-plan', sessionName: 'cortex-plan' }),
      step({ stepIndex: 1, stage: 'Execute', status: 'completed', costUsd: 2.1, durationS: 2340 }),
      step({ stepIndex: 2, stage: 'Review', status: 'running', agentSlotId: 'slot-2', executionId: 'exec_31b0', costUsd: 0.38, durationS: 252, sessionId: 'cortex-review', sessionName: 'cortex-review' }),
      step({ stepIndex: 3, stage: 'Commit', status: 'pending' }),
    ],
    dispatches: [dispatch({ executionId: 'exec_31b0', agentSlotId: 'slot-2', stepIndex: 1, machine: 'local', type: 'local' })],
    children: [
      child({ id: 'thr_b7f3', templateName: 'verify-metrics', status: 'running', depth: 0, costUsd: 0.11, activeAgent: 'analyst' }),
      child({ id: 'thr_c1', templateName: 'check-claims', status: 'completed', depth: 0, costUsd: 0.12 }),
    ],
    artifacts: {
      artifactPath: 'experiments/domain-rand-sweep.md',
      workspacePath: '/ws/thr_8f2c',
      taskId: 'T-041',
      taskProject: 'quad-nav-sim2real',
      content: '# Verified artifact\n\nBody marker.',
    },
  });

  it('builds one row per step with done/running/pending kinds', () => {
    const vm = buildThreadDetailVm(expDetail, NOW);
    expect(vm.steps).toHaveLength(4);
    expect(vm.steps.map((s) => s.kind)).toEqual(['done', 'done', 'running', 'pending']);
  });

  it('carries the per-step session id / name / index for the expandable chat', () => {
    const vm = buildThreadDetailVm(expDetail, NOW);
    // every step exposes its own session so any step (not just the running one) can render its chat
    expect(vm.steps.map((s) => s.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(vm.steps[0].sessionId).toBe('cortex-plan');
    expect(vm.steps[0].sessionName).toBe('cortex-plan');
    expect(vm.steps[2].sessionId).toBe('cortex-review');
    // a pending step that never started has no session
    expect(vm.steps[3].sessionId).toBeNull();
    // running step surfaces the live agent-flow profile; a completed step falls back to its slot id
    expect(vm.steps[2].profile).toBe('reviewer');
    expect(vm.steps[0].profile).toBe('slot-0');
  });

  it('expands only the running step: agent flow + sub-thread cards', () => {
    const vm = buildThreadDetailVm(expDetail, NOW);
    const running = vm.steps[2];
    expect(running.kind).toBe('running');
    expect(running.agent).toBeDefined();
    expect(running.agent?.profile).toBe('reviewer');
    expect(running.agent?.execInfo).toBe('exec_31b0 · local');
    expect(running.agent?.lastOutput).toBe('Now checking the headline claim.');
    expect(running.agent?.streaming).toBe(true);
    expect(running.subCount).toBe(2);
    expect(running.subs).toHaveLength(2);
    expect(running.subs[0]).toMatchObject({ id: 'thr_b7f3', name: 'verify-metrics', level: 'L2' });
    expect(running.subs[0].pill.text).toBe('Running');
    expect(running.subs[0].hasLine).toBe(true);
    expect(running.subs[0].line).toBe('analyst');
    expect(running.subs[1]).toMatchObject({ name: 'check-claims', level: 'L2' });
    expect(running.subs[1].pill.text).toBe('Done');
    // childless leaves (no subtree) are not drillable — matches proto-shot 04 (check-claims: no `open ›`)
    expect(running.subs[0].drillable).toBe(false);
    expect(running.subs[1].drillable).toBe(false);
    // non-running steps carry no agent / subs
    expect(vm.steps[0].agent).toBeUndefined();
    expect(vm.steps[0].subs).toHaveLength(0);
  });

  it('marks a sub-thread drillable when it has a subtree, regardless of its agent/status', () => {
    // A *terminal* sub-thread (completed, activeAgent null) that still owns children must stay
    // drillable — drillability is a property of the subtree (2b ≤5-level nesting), not the agent.
    const d = detail({
      status: 'running',
      steps: [step({ stepIndex: 0, stage: 'Review', status: 'running', agentSlotId: 'slot-0' })],
      totalSteps: 1,
      children: [
        // completed, no activeAgent, BUT has a child → drillable (the Blocker case)
        child({
          id: 'thr_done_parent',
          templateName: 'sub-audit',
          status: 'completed',
          activeAgent: null,
          depth: 0,
          children: [child({ id: 'thr_gc', templateName: 'unit-check', status: 'completed', depth: 1 })],
        }),
        // truncated leaf → drillable even with no returned children
        child({ id: 'thr_trunc', templateName: 'deep', status: 'completed', depth: 0, truncated: true }),
        // terminal leaf, no children, not truncated → NOT drillable
        child({ id: 'thr_leaf', templateName: 'leaf', status: 'completed', depth: 0 }),
      ],
    });
    const subs = buildThreadDetailVm(d, NOW).steps[0].subs;
    expect(subs[0]).toMatchObject({ id: 'thr_done_parent', hasLine: false, drillable: true });
    expect(subs[1]).toMatchObject({ id: 'thr_trunc', drillable: true });
    expect(subs[2]).toMatchObject({ id: 'thr_leaf', hasLine: false, drillable: false });
  });

  it('maps artifact content, refs, and written-by from the detail query', () => {
    const vm = buildThreadDetailVm(expDetail, NOW);
    expect(vm.artifact.path).toBe('experiments/domain-rand-sweep.md');
    expect(vm.artifact.live).toBe(true);
    expect(vm.artifact.taskId).toBe('T-041');
    expect(vm.artifact.taskProject).toBe('quad-nav-sim2real');
    expect(vm.artifact.workspacePath).toBe('/ws/thr_8f2c');
    expect(vm.artifact.content).toBe('# Verified artifact\n\nBody marker.');
    // written-by has one chip per step; the running step is the active writer
    expect(vm.artifact.writtenBy).toHaveLength(4);
    expect(vm.artifact.writtenBy[0]).toMatchObject({ active: false });
    expect(vm.artifact.writtenBy[2]).toMatchObject({ active: true });
    expect(vm.artifact.writtenBy[3]).toMatchObject({ active: false });
  });

  it('handles a terminal thread: no live state, no active agents', () => {
    const done = detail({
      id: 'thr_done',
      status: 'completed',
      createdAt: '2026-07-06T00:00:00.000Z',
      endedAt: '2026-07-06T00:05:00.000Z',
      totalCostUsd: 0.07,
      steps: [
        step({ stepIndex: 0, stage: 'recount', status: 'completed', costUsd: 0.05, durationS: 360 }),
        step({ stepIndex: 1, stage: 'report', status: 'completed', costUsd: 0.02, durationS: 60 }),
      ],
      artifacts: { artifactPath: 'audits/a.md', workspacePath: null, taskId: null, taskProject: null },
    });
    const vm = buildThreadDetailVm(done, NOW);
    expect(vm.live).toBe(false);
    expect(vm.artifact.live).toBe(false);
    expect(vm.steps.every((s) => s.agent === undefined)).toBe(true);
  });
});
