import { describe, it, expect } from 'vitest';
import type { TaskVerificationInfo } from '@cortex-agent/ui-contract';
import {
  buildTaskVerificationVm,
  formatDuration,
  formatCost,
  formatWhen,
} from './task-verification-vm';

const base: TaskVerificationInfo = {
  taskId: 'done1',
  project: 'atlas',
  evidence: {
    doneWhen: 'tests green + merged',
    completed: true,
    completedAt: '2026-06-01T00:01:30.000Z',
    completedNote: 'merged; suite green',
    completingExecutionId: 'exec_c',
    completingOutput: 'final merged output',
  },
  dispatches: [
    { executionId: 'exec_c', type: 'dispatch', status: 'completed', machine: 'server-nvidia', threadId: 'thr_c', startedAt: '2026-06-01T00:01:20.000Z', finishedAt: '2026-06-01T00:01:30.000Z', durationMs: 10000, cost: 0.05 },
    { executionId: 'exec_b', type: 'dispatch', status: 'failed', machine: 'lab-ksu', threadId: 'thr_b', startedAt: '2026-06-01T00:00:20.000Z', finishedAt: '2026-06-01T00:00:25.000Z', durationMs: 5000, cost: 0.01 },
  ],
};

describe('formatDuration', () => {
  it('null / negative → em dash', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
  it('sub-minute → seconds with one decimal', () => {
    expect(formatDuration(10000)).toBe('10.0s');
  });
  it('over a minute → m s', () => {
    expect(formatDuration(65000)).toBe('1m 5s');
  });
});

describe('formatCost', () => {
  it('null → em dash', () => expect(formatCost(null)).toBe('—'));
  it('number → 4dp dollars', () => expect(formatCost(0.05)).toBe('$0.0500'));
});

describe('formatWhen', () => {
  it('null / unparseable → em dash', () => {
    expect(formatWhen(null)).toBe('—');
    expect(formatWhen('not-a-date')).toBe('—');
  });
  it('iso → MM-DD HH:mm', () => {
    // formatting is local-time; assert the pattern, not the exact hour.
    expect(formatWhen('2026-06-01T00:01:20.000Z')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('buildTaskVerificationVm — real evidence', () => {
  it('surfaces real completion evidence', () => {
    const vm = buildTaskVerificationVm(base);
    expect(vm.completed).toBe(true);
    expect(vm.hasEvidence).toBe(true);
    expect(vm.doneWhen).toBe('tests green + merged');
    expect(vm.completedNote).toBe('merged; suite green');
    expect(vm.completingExecutionId).toBe('exec_c');
    expect(vm.completingOutput).toBe('final merged output');
  });

  it('maps dispatch rows and flags the completing one', () => {
    const vm = buildTaskVerificationVm(base);
    expect(vm.hasDispatches).toBe(true);
    expect(vm.dispatches.map((d) => d.executionId)).toEqual(['exec_c', 'exec_b']);
    expect(vm.dispatches[0].isCompleting).toBe(true);
    expect(vm.dispatches[0].duration).toBe('10.0s');
    expect(vm.dispatches[0].cost).toBe('$0.0500');
    expect(vm.dispatches[0].machine).toBe('server-nvidia');
    expect(vm.dispatches[1].isCompleting).toBe(false);
  });
});

describe('buildTaskVerificationVm — honest placeholders (no fabrication)', () => {
  it('open task → no evidence, empty dispatches', () => {
    const vm = buildTaskVerificationVm({
      taskId: 'open1',
      project: 'nimbus',
      evidence: { doneWhen: 'plan written', completed: false, completedAt: null, completedNote: null, completingExecutionId: null, completingOutput: null },
      dispatches: [],
    });
    expect(vm.completed).toBe(false);
    expect(vm.hasEvidence).toBe(false);
    expect(vm.hasDispatches).toBe(false);
    expect(vm.dispatches).toEqual([]);
    expect(vm.doneWhen).toBe('plan written');
  });

  it('completed with no linked execution → note kept, no completing row', () => {
    const vm = buildTaskVerificationVm({
      taskId: 'done2',
      project: 'orchard',
      evidence: { doneWhen: null, completed: true, completedAt: '2026-06-01T00:00:05.000Z', completedNote: 'done by hand', completingExecutionId: null, completingOutput: null },
      dispatches: [],
    });
    expect(vm.hasEvidence).toBe(true);
    expect(vm.completedNote).toBe('done by hand');
    expect(vm.completingExecutionId).toBe(null);
    expect(vm.hasDispatches).toBe(false);
    expect(vm.dispatches.some((d) => d.isCompleting)).toBe(false);
  });
});
