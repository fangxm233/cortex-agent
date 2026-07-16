import { describe, it, expect } from 'vitest';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { buildMMachinesVm } from './m-machines-vm';

const NOW = new Date('2026-07-15T12:00:00Z').getTime();

// Neutral fixtures (守则11): nimbus/atlas — no real machine names.
function mk(p: Partial<MachineInfo> & { name: string }): MachineInfo {
  return {
    name: p.name,
    cortexPath: p.cortexPath ?? '/home/user/.cortex',
    gpuCount: p.gpuCount ?? null,
    sshConfigured: p.sshConfigured ?? true,
    os: p.os ?? 'unix',
    online: p.online ?? false,
    connectedAt: p.connectedAt ?? null,
    lastHeartbeat: p.lastHeartbeat ?? null,
    capabilities: p.capabilities ?? [],
    liveRuns: p.liveRuns ?? 0,
  };
}

describe('buildMMachinesVm', () => {
  it('returns empty vm for empty input', () => {
    const vm = buildMMachinesVm([], NOW);
    expect(vm.cards).toEqual([]);
    expect(vm.onlineCount).toBe(0);
    expect(vm.total).toBe(0);
  });

  it('counts online/total for the daemon status line', () => {
    const machines = [
      mk({ name: 'atlas', online: true }),
      mk({ name: 'nimbus', online: false }),
    ];
    const vm = buildMMachinesVm(machines, NOW);
    expect(vm.onlineCount).toBe(1);
    expect(vm.total).toBe(2);
  });

  it('preserves input order and reuses machineCardVm fields (name/online/gpu/liveRuns/os)', () => {
    const machines = [
      mk({ name: 'atlas', online: true, gpuCount: 2, liveRuns: 3, os: 'unix' }),
      mk({ name: 'nimbus', online: false, gpuCount: null, os: 'windows' }),
    ];
    const vm = buildMMachinesVm(machines, NOW);
    expect(vm.cards.map((c) => c.name)).toEqual(['atlas', 'nimbus']);
    expect(vm.cards[0]).toMatchObject({ online: true, gpuCount: 2, liveRuns: 3, os: 'unix' });
    expect(vm.cards[1]).toMatchObject({ online: false, gpuCount: null, os: 'windows' });
  });

  it('formats heartbeat from lastHeartbeat via the reused fmtConnectedZh', () => {
    const hb = new Date(NOW - 30_000).toISOString();
    const vm = buildMMachinesVm([mk({ name: 'atlas', online: true, lastHeartbeat: hb })], NOW);
    expect(vm.cards[0].heartbeat).toBe('30s 前');
  });

  it('heartbeat is — for an offline machine (null lastHeartbeat — honest gap)', () => {
    const vm = buildMMachinesVm([mk({ name: 'nimbus', online: false })], NOW);
    expect(vm.cards[0].heartbeat).toBe('—');
  });
});
