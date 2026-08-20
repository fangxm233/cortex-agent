// input:  right-panel view models and DTO fixtures
// output: task-linked thread metadata, budget, and status regressions
// pos:    Verifies right-panel activity, budget, and machine models
// >>> If I am updated, update my header comment and CORTEX.md <<<

import { describe, expect, it } from 'vitest';
import type {
  ThreadStepDetail,
  ThreadDetail,
  ThreadChildNode,
  TaskInfo,
  MachineInfo,
} from '@cortex-agent/ui-contract';
import {
  stepDotKind,
  depthInfo,
  onlineMachineCount,
  subtaskActivity,
  rightPanelBudget,
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

describe('stepDotKind', () => {
  it('maps step status → dot kind', () => {
    expect(stepDotKind(step({ status: 'completed' }))).toBe('done');
    expect(stepDotKind(step({ status: 'running' }))).toBe('running');
    expect(stepDotKind(step({ status: 'pending' }))).toBe('pending');
  });
});

describe('activity row view models', () => {
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

describe('rightPanelBudget', () => {
  it('computes spend progress and caps overspend', () => {
    expect(rightPanelBudget(4.21, 10).percent).toBe(42.1);
    expect(rightPanelBudget(15, 10).percent).toBe(100);
  });

  it('uses zero progress when the limit is unavailable', () => {
    expect(rightPanelBudget(4.21, 0).percent).toBe(0);
    expect(rightPanelBudget(undefined, undefined).percent).toBe(0);
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
