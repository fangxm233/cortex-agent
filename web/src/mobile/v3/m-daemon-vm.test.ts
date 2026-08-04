import { describe, it, expect } from 'vitest';
import type {
  ThreadInfo,
  ScheduleInfo,
  ExecutionInfo,
  SystemDaemonStatus,
  DaemonProcessInfo,
} from '@cortex-agent/ui-contract';
import { buildDaemonVm } from './m-daemon-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

function thread(p: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 'thr_1',
    templateName: 'coder',
    currentStep: null,
    status: 'running',
    projectId: 'proj',
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    totalSteps: 0,
    artifactPath: null,
    ...p,
  };
}

function sched(p: Partial<ScheduleInfo> = {}): ScheduleInfo {
  return {
    id: 's1',
    type: 'interval',
    message: 'scan',
    projectId: 'proj',
    profile: null,
    nextRun: null,
    lastRun: null,
    paused: false,
    pausedBy: null,
    intervalMs: null,
    time: null,
    dayOfWeek: null,
    target: null,
    fallback: null,
    ...p,
  };
}

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

function proc(p: Partial<DaemonProcessInfo> = {}): DaemonProcessInfo {
  return {
    name: 'cortex-server',
    label: 'server',
    status: 'running',
    pid: 3021,
    uptime: '6d 4h',
    port: 7433,
    extras: null,
    ...p,
  };
}

function daemon(p: Partial<SystemDaemonStatus> = {}): SystemDaemonStatus {
  return {
    processes: [proc(), proc({ name: 'cortex-daemon', label: 'daemon', pid: 3038, port: null })],
    lastRestart: { at: null, reason: null },
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

  describe('with a real daemonStatus payload', () => {
    it('maps REAL process rows: name / label / status / pid / port / uptime', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [],
        ok: true,
        daemon: daemon(),
        now: NOW,
      });
      expect(vm.processes).toHaveLength(2);
      expect(vm.processes[0]).toMatchObject({
        name: 'cortex-server',
        label: 'server',
        status: 'running',
        pid: 3021,
        port: 7433,
        uptime: '6d 4h',
      });
      expect(vm.processes[1]).toMatchObject({
        name: 'cortex-daemon',
        label: 'daemon',
        pid: 3038,
        port: null, // honest — daemon has no listening port
      });
    });

    it('preserves the DTO status verbatim (running / stopped / unknown → dot color source)', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [],
        ok: true,
        daemon: daemon({
          processes: [
            proc({ name: 'cortex-server', status: 'running' }),
            proc({ name: 'cortex-daemon', status: 'stopped' }),
          ],
        }),
        now: NOW,
      });
      expect(vm.processes.map((p) => p.status)).toEqual(['running', 'stopped']);
    });

    it('keeps null metrics as honest nulls (e.g. uptime null on non-Linux), never fabricated', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [],
        ok: true,
        daemon: daemon({
          processes: [proc({ name: 'cortex-server', pid: null, port: null, uptime: null })],
        }),
        now: NOW,
      });
      expect(vm.processes[0]).toMatchObject({ pid: null, port: null, uptime: null });
    });

    it('flattens process extras into ordered {k,v} pairs', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [],
        ok: true,
        daemon: daemon({
          processes: [proc({ name: 'cortex-server', extras: { ws: 3, host: 'nimbus' } })],
        }),
        now: NOW,
      });
      expect(vm.processes[0].extras).toEqual([
        { k: 'ws', v: 3 },
        { k: 'host', v: 'nimbus' },
      ]);
    });

    it('surfaces lastRestart (at + reason) as a real event with a relative time', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [],
        ok: true,
        daemon: daemon({
          lastRestart: { at: new Date(NOW - 60 * 60_000).toISOString(), reason: 'manual soft restart' },
        }),
        now: NOW,
      });
      expect(vm.lastRestart).toEqual({ time: '1 小时', reason: 'manual soft restart' });
    });

    it('leaves lastRestart null when the DTO has no timestamp (honest — no fabricated restart)', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [],
        ok: true,
        daemon: daemon({ lastRestart: { at: null, reason: null } }),
        now: NOW,
      });
      expect(vm.lastRestart).toBeNull();
    });

    it('carries lastRestart with a null reason (at present, reason absent)', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [],
        ok: true,
        daemon: daemon({ lastRestart: { at: new Date(NOW - 2 * 60_000).toISOString(), reason: null } }),
        now: NOW,
      });
      expect(vm.lastRestart).toEqual({ time: '2 分钟', reason: null });
    });
  });

  describe('real summary counts (unchanged)', () => {
    it('counts active threads and schedules (real DTO lengths)', () => {
      const vm = buildDaemonVm({
        threads: [thread(), thread({ id: 'thr_2', status: 'waiting' })],
        schedules: [sched(), sched({ id: 's2' }), sched({ id: 's3' }), sched({ id: 's4' })],
        executions: [],
        ok: true,
        daemon: daemon(),
        now: NOW,
      });
      expect(vm.threadCount).toBe(2);
      expect(vm.scheduleCount).toBe(4);
    });
  });

  describe('recent executions activity (unchanged)', () => {
    it('maps recent executions into honest activity events (real time + ref + status)', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [
          exec({ id: 'exec_a', type: 'dispatch', status: 'running', startedAt: new Date(NOW - 3 * 60_000).toISOString(), taskId: 't-12ab' }),
          exec({ id: 'exec_b', type: 'local', status: 'completed', startedAt: new Date(NOW - 60 * 60_000).toISOString() }),
        ],
        ok: true,
        now: NOW,
      });
      expect(vm.events).toHaveLength(2);
      expect(vm.events[0]).toMatchObject({ id: 'exec_a', time: '3 分钟', status: 'running', tone: 'default' });
      expect(vm.events[0].ref).toContain('dispatch');
      expect(vm.events[0].ref).toContain('t-12ab'); // real taskId reference
      expect(vm.events[1]).toMatchObject({ id: 'exec_b', time: '1 小时', status: 'completed' });
    });

    it('flags failed / cancelled / stale executions with the fail tone', () => {
      const vm = buildDaemonVm({
        threads: [],
        schedules: [],
        executions: [
          exec({ id: 'e1', status: 'failed' }),
          exec({ id: 'e2', status: 'cancelled' }),
          exec({ id: 'e3', status: 'stale' }),
          exec({ id: 'e4', status: 'completed' }),
        ],
        ok: true,
        now: NOW,
      });
      expect(vm.events.map((e) => e.tone)).toEqual(['fail', 'fail', 'fail', 'default']);
    });

    it('caps the activity list at 5 events', () => {
      const executions = Array.from({ length: 9 }, (_, i) => exec({ id: `e${i}` }));
      const vm = buildDaemonVm({ threads: [], schedules: [], executions, ok: true, now: NOW });
      expect(vm.events).toHaveLength(5);
    });
  });
});
