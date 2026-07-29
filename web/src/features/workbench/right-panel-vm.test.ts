// input:  right-panel view models and DTO fixtures
// output: task-linked thread metadata and status regressions
// pos:    Verifies thread, activity, and machine view models
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type {
  ThreadInfo,
  ThreadStepDetail,
  ThreadDetail,
  ThreadChildNode,
  ThreadDispatchInfo,
  TaskInfo,
  MachineInfo,
} from '@cortex-agent/ui-contract';
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
  cortexRunLabel,
  subtaskActivity,
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
    subtasks: [],
    children: [],
    artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
    ...partial,
  };
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

describe('stepDotKind', () => {
  it('maps step status → dot kind', () => {
    expect(stepDotKind(step({ status: 'completed' }))).toBe('done');
    expect(stepDotKind(step({ status: 'running' }))).toBe('running');
    expect(stepDotKind(step({ status: 'pending' }))).toBe('pending');
  });
});

describe('activity row view models', () => {
  it('labels a real run by cortex-run name, never by execution id', () => {
    const run: ThreadDispatchInfo = {
      executionId: 'exec_dispatch_hidden', status: 'running', machine: 'lab2', type: 'dispatch',
      agentSlotId: null, stepIndex: 0, taskId: 'ab12', runName: 'root-sweep',
      startedAt: '2026-07-06T00:00:00Z', finishedAt: null, durationMs: null, cost: null,
    };
    expect(cortexRunLabel(run)).toBe('cortex-run root-sweep');
    expect(cortexRunLabel(run)).not.toContain(run.executionId);
  });

  it('maps direct subtask lifecycle to compact scheme-3a status', () => {
    const base: TaskInfo = {
      id: 'cd34', text: 'Direct child', project: 'p', status: 'open', priority: 'medium',
      actionable: true, claimedBy: null, blockedBy: null, dependsOn: [], plan: null,
      template: 'coder-review', why: null, doneWhen: null,
    };
    expect(subtaskActivity(base)).toEqual({ label: 'Open', tone: 'idle' });
    expect(subtaskActivity({ ...base, actionable: false, claimedBy: 'task-dispatcher' })).toEqual({ label: 'Running', tone: 'running' });
    expect(subtaskActivity({ ...base, actionable: false, blockedBy: 'failed' })).toEqual({ label: 'Blocked', tone: 'failed' });
    expect(subtaskActivity({ ...base, status: 'done', actionable: false })).toEqual({ label: 'Done', tone: 'done' });
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

describe('threadMetaLine', () => {
  const now = Date.parse('2026-07-06T10:00:00.000Z');
  it('shows the owning task between the thread id and current step', () => {
    expect(
      threadMetaLine(
        info({ id: 'thr_8f2c', taskId: 'a293', currentStep: { index: 2, name: 'review' }, totalSteps: 4, createdAt: '2026-07-06T09:18:00.000Z' }),
        now,
      ),
    ).toBe('thr_8f2c · task a293 · step 3/4 · 42m');
  });
  it('omits task and step when neither is present', () => {
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

describe('machinePill', () => {
  it('reports online and offline states', () => {
    expect(machinePill(true).text).toBe('Online');
    expect(machinePill(false).text).toBe('Offline');
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
