import { describe, it, expect } from 'vitest';
import type {
  ThreadDetail,
  ThreadStepDetail,
  ThreadArtifactRefs,
  ThreadAgentFlow,
} from '@cortex-agent/ui-contract';
import { buildMThreadDetailVm } from './m-thread-detail-vm';

// Neutral placeholder thread (守则11 — no real project ids / template names).
const T0 = Date.parse('2026-07-15T12:00:00.000Z');
const NOW = T0 + 252_000; // → 04:12 elapsed

function step(over: Partial<ThreadStepDetail>): ThreadStepDetail {
  return {
    stepIndex: 0,
    agentSlotId: 'slot-a',
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

const artifacts: ThreadArtifactRefs = {
  artifactPath: '/ws/out/audit-report.md',
  workspacePath: '/ws',
  taskId: null,
  taskProject: null,
};

const agentFlow: ThreadAgentFlow = {
  slotId: 'slot-b',
  profile: 'sonnet',
  status: 'running',
  stage: 'recompute',
  sessionId: 'sess-b',
  sessionName: 'cortex-0002',
  lastOutput: 'read metrics/seed.json\nbootstrap ci95 — 10k resamples\nΔ success = +9.2pt',
};

function detail(over: Partial<ThreadDetail> = {}): ThreadDetail {
  return {
    id: 'thr_c3a1',
    templateName: 'audit-pipeline',
    currentStep: { index: 1, name: 'recompute' },
    status: 'running',
    projectId: 'nimbus',
    createdAt: new Date(T0).toISOString(),
    updatedAt: new Date(NOW - 120_000).toISOString(),
    totalSteps: 3,
    artifactPath: '/ws/out/audit-report.md',
    endedAt: null,
    error: null,
    abortReason: null,
    activeAgent: 'auditor',
    activeStage: 'recompute',
    totalCostUsd: 0.41,
    steps: [
      step({ stepIndex: 0, stage: 'collect', status: 'completed', durationS: 120, outputSummary: '8 seeds · metrics/*.json' }),
      step({
        stepIndex: 1,
        agentSlotId: 'slot-b',
        stage: 'recompute',
        status: 'running',
        startedAt: new Date(T0 + 125_000).toISOString(), // → 02:07 active clock
        costUsd: 0.09,
        numTurns: 6,
        sessionId: 'sess-b',
      }),
      step({ stepIndex: 2, stage: 'report', status: 'pending' }),
    ],
    agentFlow,
    subtasks: [],
    children: [],
    artifacts,
    ...over,
  };
}

describe('buildMThreadDetailVm', () => {
  it('builds the breadcrumb from the drill trail + real self depth', () => {
    const vm = buildMThreadDetailVm(detail(), [
      { id: 'thr_root', name: 'experiment-pipeline' },
      { id: 'thr_mid', name: 'verify-metrics' },
    ], NOW);
    expect(vm.crumbs.map((c) => c.name)).toEqual(['experiment-pipeline', 'verify-metrics']);
    expect(vm.selfLevel).toBe(3); // trail.length + 1
    expect(vm.depthText).toBe('1/5'); // no children → subtree depth 1, MAX 5
  });

  it('omits self level when no ancestry trail is carried (honest — just name + depth)', () => {
    const vm = buildMThreadDetailVm(detail(), [], NOW);
    expect(vm.crumbs).toEqual([]);
    expect(vm.selfLevel).toBeNull();
    expect(vm.depthText).toBe('1/5');
  });

  it('maps a completed step to a collapsed row with a connector', () => {
    const vm = buildMThreadDetailVm(detail(), [], NOW);
    const done = vm.steps[0];
    expect(done.kind).toBe('done');
    expect(done.name).toBe('collect');
    expect(done.agent).toBeUndefined();
    expect(done.hasConnector).toBe(true);
  });

  it('expands the running step with its live agent-flow lines', () => {
    const vm = buildMThreadDetailVm(detail(), [], NOW);
    const active = vm.steps[1];
    expect(active.kind).toBe('running');
    expect(active.agent).toBeDefined();
    expect(active.agent!.lines).toEqual([
      'read metrics/seed.json',
      'bootstrap ci95 — 10k resamples',
      'Δ success = +9.2pt',
    ]);
    expect(active.agent!.live).toBe(true);
  });

  it('maps a pending step to a faint row with no agent box and no connector (last)', () => {
    const vm = buildMThreadDetailVm(detail(), [], NOW);
    const pending = vm.steps[2];
    expect(pending.kind).toBe('pending');
    expect(pending.name).toBe('report');
    expect(pending.agent).toBeUndefined();
    expect(pending.hasConnector).toBe(false);
  });

  it('lists real artifacts by basename', () => {
    const vm = buildMThreadDetailVm(detail(), [], NOW);
    expect(vm.artifactCount).toBe(1);
    expect(vm.artifacts[0].filename).toBe('audit-report.md');
  });

  it('yields zero artifacts when the DTO carries no artifact path', () => {
    const vm = buildMThreadDetailVm(
      detail({ artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null } }),
      [],
      NOW,
    );
    expect(vm.artifactCount).toBe(0);
    expect(vm.artifacts).toEqual([]);
  });

  it('is not live and hides the elapsed run-clock advance for a terminal thread', () => {
    const vm = buildMThreadDetailVm(
      detail({ status: 'completed', endedAt: new Date(T0 + 60_000).toISOString() }),
      [],
      NOW,
    );
    expect(vm.live).toBe(false);
    expect(vm.elapsed).toBe('01:00'); // clamped to endedAt, not now
  });
});
