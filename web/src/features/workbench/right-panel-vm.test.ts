import { describe, expect, it } from 'vitest';
import type { ThreadInfo, ThreadStepDetail, ThreadDetail, ThreadChildNode, MachineInfo } from '@cortex-agent/ui-contract';
import {
  threadPill,
  stepDotKind,
  formatCost,
  formatDurationS,
  stepMeta,
  formatAge,
  threadMetaLine,
  depthInfo,
  machinePill,
  onlineMachineCount,
} from './right-panel-vm';

function step(partial: Partial<ThreadStepDetail>): ThreadStepDetail {
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
    ...partial,
  };
}

function child(partial: Partial<ThreadChildNode>): ThreadChildNode {
  return {
    id: 'thr_c',
    templateName: null,
    status: 'running',
    activeAgent: null,
    costUsd: 0,
    depth: 0,
    createdAt: '2026-07-06T00:00:00.000Z',
    taskId: null,
    children: [],
    truncated: false,
    ...partial,
  };
}

function info(partial: Partial<ThreadInfo>): ThreadInfo {
  return {
    id: 'thr_8f2c',
    templateName: 'coder-review',
    currentStep: null,
    status: 'running',
    projectId: 'p',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    totalSteps: 4,
    artifactPath: null,
    ...partial,
  };
}

function detail(partial: Partial<ThreadDetail>): ThreadDetail {
  return {
    id: 'thr_8f2c',
    templateName: 'coder-review',
    currentStep: null,
    status: 'running',
    projectId: 'p',
    createdAt: '2026-07-06T00:00:00.000Z',
    updatedAt: '2026-07-06T00:00:00.000Z',
    totalSteps: 4,
    artifactPath: null,
    endedAt: null,
    error: null,
    abortReason: null,
    activeAgent: null,
    activeStage: null,
    totalCostUsd: 0,
    steps: [],
    agentFlow: null,
    dispatches: [],
    children: [],
    artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
    ...partial,
  };
}

describe('threadPill — verbatim prototype pill() hexes (L1841–1848)', () => {
  it('running → #EEF0FA/#4655D4 Running', () => {
    expect(threadPill('running')).toEqual({ bg: '#EEF0FA', fg: '#4655D4', text: 'Running' });
  });
  it('waiting → #F7ECCE/#8A5B06 Waiting', () => {
    expect(threadPill('waiting')).toEqual({ bg: '#F7ECCE', fg: '#8A5B06', text: 'Waiting' });
  });
  it('completed → #E9F4EE/#23854F Done', () => {
    expect(threadPill('completed')).toEqual({ bg: '#E9F4EE', fg: '#23854F', text: 'Done' });
  });
  it('failed → #FBEDEB/#C03D33 Failed', () => {
    expect(threadPill('failed')).toEqual({ bg: '#FBEDEB', fg: '#C03D33', text: 'Failed' });
  });
  it('cancelled and aborted → #F1F2F5/#8A93A2 Cancelled (default)', () => {
    expect(threadPill('cancelled')).toEqual({ bg: '#F1F2F5', fg: '#8A93A2', text: 'Cancelled' });
    expect(threadPill('aborted')).toEqual({ bg: '#F1F2F5', fg: '#8A93A2', text: 'Cancelled' });
  });
});

describe('stepDotKind', () => {
  it('maps step status → dot kind', () => {
    expect(stepDotKind(step({ status: 'completed' }))).toBe('done');
    expect(stepDotKind(step({ status: 'running' }))).toBe('running');
    expect(stepDotKind(step({ status: 'pending' }))).toBe('pending');
  });
});

describe('formatCost / formatDurationS', () => {
  it('cost → 2-decimal $', () => {
    expect(formatCost(2.1)).toBe('$2.10');
    expect(formatCost(0)).toBe('$0.00');
  });
  it('duration → compact clock, rounding seconds', () => {
    expect(formatDurationS(45)).toBe('45s');
    expect(formatDurationS(60)).toBe('1m');
    expect(formatDurationS(207)).toBe('3m 27s');
    expect(formatDurationS(2340)).toBe('39m');
    expect(formatDurationS(45.6)).toBe('46s');
  });
});

describe('stepMeta — "39m · $2.10" (duration then cost)', () => {
  it('joins present parts with " · "', () => {
    expect(stepMeta(step({ durationS: 2340, costUsd: 2.1 }))).toBe('39m · $2.10');
  });
  it('omits null parts', () => {
    expect(stepMeta(step({ durationS: null, costUsd: 0.04 }))).toBe('$0.04');
    expect(stepMeta(step({ durationS: 180, costUsd: null }))).toBe('3m');
    expect(stepMeta(step({}))).toBe('');
  });
});

describe('formatAge', () => {
  const now = Date.parse('2026-07-06T10:00:00.000Z');
  it('sub-minute → just now', () => {
    expect(formatAge('2026-07-06T09:59:30.000Z', now)).toBe('just now');
  });
  it('minutes', () => {
    expect(formatAge('2026-07-06T09:18:00.000Z', now)).toBe('42m');
  });
  it('hours', () => {
    expect(formatAge('2026-07-06T07:00:00.000Z', now)).toBe('3h');
  });
  it('days', () => {
    expect(formatAge('2026-07-04T10:00:00.000Z', now)).toBe('2d');
  });
});

describe('threadMetaLine — "thr_8f2c · step 3/4 · 42m"', () => {
  const now = Date.parse('2026-07-06T10:00:00.000Z');
  it('includes step when currentStep present', () => {
    expect(
      threadMetaLine(
        info({ id: 'thr_8f2c', currentStep: { index: 2, name: 'review' }, totalSteps: 4, createdAt: '2026-07-06T09:18:00.000Z' }),
        now,
      ),
    ).toBe('thr_8f2c · step 3/4 · 42m');
  });
  it('omits step when no currentStep', () => {
    expect(
      threadMetaLine(info({ id: 'thr_a41d', currentStep: null, createdAt: '2026-07-06T09:18:00.000Z' }), now),
    ).toBe('thr_a41d · 42m');
  });
});

describe('depthInfo — dots filled = deepest child level, total = 5', () => {
  it('no children → 1/5', () => {
    expect(depthInfo(detail({ children: [] }))).toEqual({ filled: 1, total: 5, text: '1/5' });
  });
  it('nested tree → deepest level clamped to 5', () => {
    const tree = detail({
      children: [child({ depth: 0, children: [child({ depth: 1, children: [child({ depth: 2 })] })] })],
    });
    // depth 2 → level 4
    expect(depthInfo(tree)).toEqual({ filled: 4, total: 5, text: '4/5' });
  });
});

describe('machinePill — online/offline status pill', () => {
  it('online → #E9F4EE/#23854F Online', () => {
    expect(machinePill(true)).toEqual({ bg: '#E9F4EE', fg: '#23854F', text: 'Online' });
  });
  it('offline → #F1F2F5/#8A93A2 Offline', () => {
    expect(machinePill(false)).toEqual({ bg: '#F1F2F5', fg: '#8A93A2', text: 'Offline' });
  });
});

describe('onlineMachineCount — Machines tab badge counts ONLINE only, not total', () => {
  const machine = (online: boolean): MachineInfo => ({
    name: online ? 'atlas' : 'nimbus',
    cortexPath: null,
    gpuCount: null,
    sshConfigured: false,
    os: 'unix',
    online,
    connectedAt: null,
    lastHeartbeat: null,
    capabilities: [],
    liveRuns: 0,
  });
  it('counts only online machines', () => {
    expect(onlineMachineCount([machine(true), machine(false), machine(true)])).toBe(2);
  });
  it('all offline → 0 (even though total > 0)', () => {
    expect(onlineMachineCount([machine(false), machine(false)])).toBe(0);
  });
  it('empty / undefined → 0', () => {
    expect(onlineMachineCount([])).toBe(0);
    expect(onlineMachineCount(undefined)).toBe(0);
  });
});
