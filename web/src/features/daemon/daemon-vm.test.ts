// input:  all legal daemon process states and nullable daemon status DTO fields
// output: canonical process tones, extras and restart fact regressions
// pos:    Locale- and CSS-free daemon fact specification
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { DaemonProcessInfo, SystemDaemonStatus } from '@cortex-agent/ui-contract';
import { describe, expect, it } from 'vitest';
import { buildDaemonVm, daemonStatusTone } from './daemon-vm';

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

function status(): SystemDaemonStatus {
  return {
    processes: [process('running'), process('stopped'), process('unknown')],
    lastRestart: { at: '2026-08-27T20:00:00.000Z', reason: 'manual' },
  };
}

describe('daemonStatusTone', () => {
  it('maps every legal daemon state, with unknown using the cancelled tone', () => {
    const states: DaemonProcessInfo['status'][] = ['running', 'stopped', 'unknown'];
    expect(states.map(daemonStatusTone)).toEqual([
      'done',
      'failed',
      'cancelled',
    ]);
  });
});

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
    expect(buildDaemonVm(null)).toEqual({ processes: [], lastRestart: null });
  });
});
