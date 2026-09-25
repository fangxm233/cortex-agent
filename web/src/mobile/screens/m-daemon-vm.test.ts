import { describe, it, expect } from 'vitest';
import type { ExecutionInfo } from '@cortex-agent/ui-contract';
import { buildDaemonVm } from './m-daemon-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

function exec(p: Partial<ExecutionInfo> = {}): ExecutionInfo {
  return {
    id: 'exec_1',
    type: 'dispatch',
    status: 'running',
    taskId: null,
    sessionId: null,
    projectId: 'proj',
    machine: null,
    startedAt: new Date(NOW).toISOString(),
    finishedAt: null,
    durationMs: null,
    cost: null,
    ...p,
  };
}

describe('buildDaemonVm', () => {
  describe('without a daemonStatus payload (honest fallback)', () => {
    it('returns zeroed vm for empty input, with the two named processes running when ok', () => {
      const vm = buildDaemonVm({ threads: [], schedules: [], executions: [], ok: true, now: NOW });
      expect(vm.threadCount).toBe(0);
      expect(vm.scheduleCount).toBe(0);
      expect(vm.events).toEqual([]);
      expect(vm.lastRestart).toBeNull();
      expect(vm.processes.map((p) => p.name)).toEqual(['cortex-server', 'cortex-daemon']);
      expect(vm.processes.every((p) => p.status === 'running')).toBe(true);
      // No real metrics available in the fallback → honest nulls, never fabricated.
      expect(vm.processes.every((p) => p.pid === null && p.port === null && p.uptime === null)).toBe(true);
      expect(vm.ok).toBe(true);
    });

    it('marks both processes status=unknown when the daemon is unreachable (queries failed)', () => {
      const vm = buildDaemonVm({ threads: [], schedules: [], executions: [], ok: false, now: NOW });
      expect(vm.ok).toBe(false);
      expect(vm.processes.every((p) => p.status === 'unknown')).toBe(true);
    });
  });

  describe('recent executions activity (unchanged)', () => {
    it('caps the activity list at 5 events', () => {
      const executions = Array.from({ length: 9 }, (_, i) => exec({ id: `e${i}` }));
      const vm = buildDaemonVm({ threads: [], schedules: [], executions, ok: true, now: NOW });
      expect(vm.events).toHaveLength(5);
    });
  });
});
