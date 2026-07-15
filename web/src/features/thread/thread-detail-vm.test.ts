import { describe, it, expect } from 'vitest';
import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadChildNode,
  ThreadDispatchInfo,
} from '@cortex-agent/ui-contract';
import { buildThreadDetailVm, threadPill, fmtClock } from './thread-detail-vm';

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
    taskId: p.taskId ?? null,
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

describe('threadPill', () => {
  it('maps thread statuses to the prototype pill pairs', () => {
    expect(threadPill('running')).toEqual({ bg: '#EEF0FA', fg: '#4655D4', text: 'Running' });
    expect(threadPill('waiting')).toEqual({ bg: '#F7ECCE', fg: '#8A5B06', text: 'Waiting' });
    expect(threadPill('completed')).toEqual({ bg: '#E9F4EE', fg: '#23854F', text: 'Done' });
    expect(threadPill('failed')).toEqual({ bg: '#FBEDEB', fg: '#C03D33', text: 'Failed' });
    expect(threadPill('cancelled')).toEqual({ bg: '#F1F2F5', fg: '#8A93A2', text: 'Cancelled' });
  });
});

describe('fmtClock', () => {
  it('zero-pads MM:SS and does not roll minutes into hours', () => {
    expect(fmtClock(21)).toBe('00:21');
    expect(fmtClock(42 * 60 + 18)).toBe('42:18');
    expect(fmtClock(0)).toBe('00:00');
  });
});

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
    dispatches: [dispatch({ executionId: 'exec_31b0', agentSlotId: 'slot-2', machine: 'local', type: 'local' })],
    children: [
      child({ id: 'thr_b7f3', templateName: 'verify-metrics', status: 'running', depth: 0, costUsd: 0.11, activeAgent: 'analyst' }),
      child({ id: 'thr_c1', templateName: 'check-claims', status: 'completed', depth: 0, costUsd: 0.12 }),
    ],
    artifacts: {
      artifactPath: 'experiments/domain-rand-sweep.md',
      workspacePath: '/ws/thr_8f2c',
      taskId: 'T-041',
      taskProject: 'quad-nav-sim2real',
    },
  });

  it('maps the header, pill, meta fields and depth', () => {
    const vm = buildThreadDetailVm(expDetail, [], NOW);
    expect(vm.name).toBe('plan-exec-review');
    expect(vm.tid).toBe('thr_8f2c');
    expect(vm.pill).toEqual({ bg: '#EEF0FA', fg: '#4655D4', text: 'Running' });
    expect(vm.live).toBe(true);
    expect(vm.template).toBe('plan-exec-review');
    expect(vm.cost).toBe('Σ $2.52');
    expect(vm.task).toBe('T-041');
    expect(vm.elapsed).toBe('42:18'); // 00:00 → 00:42:18 elapsed
    expect(vm.depthText).toBe('2/5'); // direct children (depth 0) reach level 2
    expect(vm.depthDots).toHaveLength(5);
    expect(vm.depthDots.filter((d) => d.filled)).toHaveLength(2);
  });

  it('root crumb is the project (non-accent); ancestors from the trail are accent', () => {
    const vm = buildThreadDetailVm(expDetail, [], NOW);
    expect(vm.crumbs).toHaveLength(1);
    expect(vm.crumbs[0]).toMatchObject({ name: 'quad-nav-sim2real', accent: false });

    const nested = buildThreadDetailVm(expDetail, [
      { id: 'thr_root', name: 'experiment-pipeline' },
      { id: 'thr_mid', name: 'verify-metrics' },
    ], NOW);
    expect(nested.crumbs).toHaveLength(3);
    expect(nested.crumbs[0]).toMatchObject({ name: 'quad-nav-sim2real', accent: false });
    expect(nested.crumbs[1]).toMatchObject({ name: 'experiment-pipeline', accent: true, id: 'thr_root' });
    expect(nested.crumbs[2]).toMatchObject({ name: 'verify-metrics', accent: true, id: 'thr_mid' });
  });

  it('builds one row per step, connectors after the first, done/running/pending kinds', () => {
    const vm = buildThreadDetailVm(expDetail, [], NOW);
    expect(vm.steps).toHaveLength(4);
    expect(vm.steps.map((s) => s.kind)).toEqual(['done', 'done', 'running', 'pending']);
    expect(vm.steps[0].hasConnector).toBe(false);
    expect(vm.steps[1].hasConnector).toBe(true);
    expect(vm.steps[0].title).toBe('1 · Plan');
    expect(vm.steps[0].meta).toBe('3m · $0.04');
    expect(vm.steps[3].meta).toBe('gated');
  });

  it('carries the per-step session id / name / index for the expandable chat', () => {
    const vm = buildThreadDetailVm(expDetail, [], NOW);
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
    const vm = buildThreadDetailVm(expDetail, [], NOW);
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
    const subs = buildThreadDetailVm(d, [], NOW).steps[0].subs;
    expect(subs[0]).toMatchObject({ id: 'thr_done_parent', hasLine: false, drillable: true });
    expect(subs[1]).toMatchObject({ id: 'thr_trunc', drillable: true });
    expect(subs[2]).toMatchObject({ id: 'thr_leaf', hasLine: false, drillable: false });
  });

  it('maps the artifact refs header + written-by from steps (content is a Stage-6 gap)', () => {
    const vm = buildThreadDetailVm(expDetail, [], NOW);
    expect(vm.artifact.path).toBe('experiments/domain-rand-sweep.md');
    expect(vm.artifact.live).toBe(true);
    expect(vm.artifact.taskId).toBe('T-041');
    expect(vm.artifact.taskProject).toBe('quad-nav-sim2real');
    expect(vm.artifact.workspacePath).toBe('/ws/thr_8f2c');
    expect(vm.artifact.contentGap).toBe(true);
    // written-by has one chip per step; the running step is the active writer
    expect(vm.artifact.writtenBy).toHaveLength(4);
    expect(vm.artifact.writtenBy[0]).toMatchObject({ label: '1 Plan · done', active: false });
    expect(vm.artifact.writtenBy[2]).toMatchObject({ label: '3 Review · editing', active: true });
    expect(vm.artifact.writtenBy[3]).toMatchObject({ label: '4 Commit · queued', active: false });
  });

  it('handles a terminal thread: Done pill, no live, elapsed to endedAt, task "—"', () => {
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
    const vm = buildThreadDetailVm(done, [], NOW);
    expect(vm.pill.text).toBe('Done');
    expect(vm.live).toBe(false);
    expect(vm.elapsed).toBe('05:00');
    expect(vm.task).toBe('—');
    expect(vm.artifact.live).toBe(false);
    expect(vm.steps.every((s) => s.agent === undefined)).toBe(true);
  });
});
