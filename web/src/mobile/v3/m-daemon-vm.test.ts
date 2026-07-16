import { describe, it, expect } from 'vitest';
import type { ThreadInfo, ScheduleInfo, ExecutionInfo } from '@cortex-agent/ui-contract';
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

describe('buildDaemonVm', () => {
  it('returns zeroed vm for empty input, with the two named processes', () => {
    const vm = buildDaemonVm({ threads: [], schedules: [], executions: [], ok: true, now: NOW });
    expect(vm.threadCount).toBe(0);
    expect(vm.scheduleCount).toBe(0);
    expect(vm.events).toEqual([]);
    expect(vm.processes.map((p) => p.name)).toEqual(['cortex-server', 'cortex-daemon']);
    expect(vm.processes.every((p) => p.live)).toBe(true);
    expect(vm.ok).toBe(true);
  });

  it('counts active threads and schedules (real DTO lengths)', () => {
    const vm = buildDaemonVm({
      threads: [thread(), thread({ id: 'thr_2', status: 'waiting' })],
      schedules: [sched(), sched({ id: 's2' }), sched({ id: 's3' }), sched({ id: 's4' })],
      executions: [],
      ok: true,
      now: NOW,
    });
    expect(vm.threadCount).toBe(2);
    expect(vm.scheduleCount).toBe(4);
  });

  it('marks both processes NOT live when the daemon is unreachable (queries failed)', () => {
    const vm = buildDaemonVm({ threads: [], schedules: [], executions: [], ok: false, now: NOW });
    expect(vm.ok).toBe(false);
    expect(vm.processes.every((p) => !p.live)).toBe(true);
  });

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
