import { describe, expect, it } from 'vitest';
import type {
  ThreadDetail,
  ThreadChildNode,
  MachineInfo,
} from '@cortex-agent/ui-contract';
import {
  depthInfo,
  onlineMachineCount,
} from './right-panel-vm';

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
    subtasks: [],
    children: [],
    artifacts: { artifactPath: null, workspacePath: null, taskId: null, taskProject: null },
    ...partial,
  };
}

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
});
