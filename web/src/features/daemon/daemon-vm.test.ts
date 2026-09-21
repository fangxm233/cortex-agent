import type {
  DaemonProcessInfo,
  DaemonRebuildProgress,
  DaemonRebuildStep,
  SystemDaemonStatus,
} from '@cortex-agent/ui-contract';
import { describe, expect, it } from 'vitest';
import { buildDaemonVm } from './daemon-vm';

function process(status: DaemonProcessInfo['status']): DaemonProcessInfo {
  return {
    name: `cortex-${status}`,
    label: status,
    status,
    pid: status === 'running' ? 41 : null,
    uptime: status === 'running' ? '2h 4m' : null,
    port: null,
    extras: status === 'running' ? { clients: 3, host: 'atlas' } : null,
  };
}

function status(rebuild: DaemonRebuildProgress | null = null): SystemDaemonStatus {
  return {
    processes: [process('running'), process('stopped'), process('unknown')],
    lastRestart: { at: '2026-08-27T20:00:00.000Z', reason: 'manual' },
    rebuild,
  };
}

const T0 = Date.parse('2026-09-21T06:00:00.000Z');

function step(
  name: DaemonRebuildStep['name'],
  status: DaemonRebuildStep['status'],
  span?: { from: number; to?: number },
  detail: string | null = null,
): DaemonRebuildStep {
  return {
    name,
    status,
    detail,
    startedAt: span ? new Date(T0 + span.from).toISOString() : null,
    endedAt: span?.to != null ? new Date(T0 + span.to).toISOString() : null,
  };
}

/** A pipeline caught mid-web-build: two steps done, one running, two never started. */
function runningRebuild(): DaemonRebuildProgress {
  return {
    status: 'running',
    reason: 'src change: core/foo.ts',
    current: 'web',
    steps: [
      step('server', 'done', { from: 0, to: 4_000 }),
      step('ui-contract', 'done', { from: 4_000, to: 5_500 }),
      step('web', 'running', { from: 5_500 }),
      step('install', 'pending'),
      step('restart', 'pending'),
    ],
    startedAt: new Date(T0).toISOString(),
    updatedAt: new Date(T0 + 5_500).toISOString(),
    endedAt: null,
    detail: null,
    daemonPid: 4242,
  };
}

describe('buildDaemonVm', () => {
  it('keeps real process metrics and flattens extras without presentation tokens', () => {
    const vm = buildDaemonVm(status());
    expect(vm.processes[0]).toMatchObject({
      name: 'cortex-running', status: 'running', tone: 'done', pid: 41, uptime: '2h 4m',
    });
    expect(vm.processes[0].extras).toEqual([
      { key: 'clients', value: 3 },
      { key: 'host', value: 'atlas' },
    ]);
    expect(vm.processes[1].extras).toEqual([]);
  });

  it('preserves the real restart record and has an honest empty fallback', () => {
    expect(buildDaemonVm(status()).lastRestart).toEqual({
      at: '2026-08-27T20:00:00.000Z', reason: 'manual',
    });
    expect(buildDaemonVm(null)).toEqual({ processes: [], lastRestart: null, rebuild: null });
  });

  it('has no rebuild facts when the supervisor published none', () => {
    expect(buildDaemonVm(status()).rebuild).toBeNull();
  });

  it('times a running rebuild against the caller\'s clock, not a hidden one', () => {
    const vm = buildDaemonVm(status(runningRebuild()), T0 + 12_000);
    const rebuild = vm.rebuild!;
    expect(rebuild).toMatchObject({
      status: 'running', running: true, current: 'web', completed: 2, total: 5,
      reason: 'src change: core/foo.ts', elapsed: '12s',
    });
    // Finished steps are timed by their own span; the one in flight runs up to `now`.
    expect(rebuild.steps.map((s) => [s.name, s.status, s.tone, s.duration])).toEqual([
      ['server', 'done', 'done', '4.0s'],
      ['ui-contract', 'done', 'done', '1.5s'],
      ['web', 'running', 'running', '6.5s'],
      ['install', 'pending', 'waiting', null],
      ['restart', 'pending', 'waiting', null],
    ]);
  });

  it('reports an aborted pipeline with the failed step and the supervisor\'s detail', () => {
    const aborted: DaemonRebuildProgress = {
      ...runningRebuild(),
      status: 'aborted',
      current: null,
      steps: [
        step('server', 'done', { from: 0, to: 4_000 }),
        step('ui-contract', 'failed', { from: 4_000, to: 4_800 }, 'exit 2'),
        step('web', 'skipped'),
        step('install', 'skipped'),
        step('restart', 'skipped'),
      ],
      endedAt: new Date(T0 + 4_800).toISOString(),
      detail: 'Rebuild aborted at step "ui-contract" (exit 2)',
    };
    const rebuild = buildDaemonVm(status(aborted), T0 + 60_000).rebuild!;
    expect(rebuild).toMatchObject({
      status: 'aborted', running: false, completed: 1, total: 5,
      detail: 'Rebuild aborted at step "ui-contract" (exit 2)',
    });
    // Terminal: the elapsed clock stops at endedAt instead of running on with `now`.
    expect(rebuild.elapsed).toBe('4.8s');
    expect(rebuild.steps[1]).toMatchObject({ status: 'failed', tone: 'failed', detail: 'exit 2' });
    expect(rebuild.steps[2]).toMatchObject({ status: 'skipped', tone: 'cancelled', duration: null });
  });
});
