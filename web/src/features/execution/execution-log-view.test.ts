import { describe, expect, it } from 'vitest';
import type { ExecutionDetailInfo } from '@cortex-agent/ui-contract';
import { isStoppable, logStreamEnabled } from './execution-log-view';

function detail(over: Partial<ExecutionDetailInfo> = {}): ExecutionDetailInfo {
  return {
    id: 'exec_3097',
    type: 'dispatch',
    kind: 'cortex-run',
    status: 'running',
    projectId: 'cortex-self',
    sessionId: null,
    threadId: 'thr_x',
    runtime: {
      startedAt: '2026-07-06T01:58:03Z',
      updatedAt: '2026-07-06T07:49:12Z',
      endedAt: null,
    },
    dispatch: {
      taskId: 'T-041',
      machine: 'gpu-01',
      pid: '4242',
      tmuxName: 'run-3097',
      sessionName: 'sess',
      scheduleTaskId: null,
      runName: 'overnight-dr',
    },
    metrics: { costUsd: 1.24, numTurns: 12, durationS: 83 },
    gpu: null,
    text: { label: 'overnight DR sweep', finalOutput: null, error: null },
    ...over,
  };
}

describe('isStoppable', () => {
  it('only a running execution is stoppable', () => {
    expect(isStoppable('running')).toBe(true);
    for (const s of ['completed', 'failed', 'cancelled', 'stale']) {
      expect(isStoppable(s)).toBe(false);
    }
  });
});

describe('logStreamEnabled', () => {
  it('true only when dispatch.runName is present (a cortex-run)', () => {
    expect(logStreamEnabled(detail())).toBe(true);
    expect(logStreamEnabled(detail({ dispatch: null }))).toBe(false);
    const d = detail();
    expect(logStreamEnabled(detail({ dispatch: { ...d.dispatch!, runName: null } }))).toBe(false);
  });
});
