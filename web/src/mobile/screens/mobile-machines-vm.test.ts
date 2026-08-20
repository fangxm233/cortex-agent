import { describe, it, expect } from 'vitest';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { machineCardVm } from './mobile-machines-vm';

// Fixtures ──────────────────────────────────────────────────────────────────────────────────────

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

// machineCardVm ──────────────────────────────────────────────────────────────────────────────

describe('machineCardVm', () => {
  it('maps name, online, liveRuns, os from DTO', () => {
    const m = mk({ name: 'lab2', online: true, liveRuns: 3, os: 'unix' });
    const vm = machineCardVm(m);
    expect(vm.name).toBe('lab2');
    expect(vm.online).toBe(true);
    expect(vm.liveRuns).toBe(3);
    expect(vm.os).toBe('unix');
  });

  it('maps gpuCount (non-null)', () => {
    const m = mk({ name: 'lab', gpuCount: 4 });
    expect(machineCardVm(m).gpuCount).toBe(4);
  });

  it('passes gpuCount null when unset', () => {
    const m = mk({ name: 'lab', gpuCount: null });
    expect(machineCardVm(m).gpuCount).toBeNull();
  });

  it('sets connectedAt to DTO connectedAt when online', () => {
    const iso = '2026-07-10T10:00:00Z';
    const m = mk({ name: 'lab', online: true, connectedAt: iso });
    expect(machineCardVm(m).connectedAt).toBe(iso);
  });

  it('sets connectedAt to null when offline (even if DTO has a stale value)', () => {
    // DTO may still carry a stale connectedAt from the last session — we hide it when offline
    const m = mk({ name: 'lab', online: false, connectedAt: '2026-07-09T08:00:00Z' });
    expect(machineCardVm(m).connectedAt).toBeNull();
  });

  it('sets connectedAt to null when online but DTO connectedAt is null', () => {
    const m = mk({ name: 'lab', online: true, connectedAt: null });
    expect(machineCardVm(m).connectedAt).toBeNull();
  });

  it('does not expose cortexPath, sshConfigured, lastHeartbeat, capabilities', () => {
    const m = mk({ name: 'lab' });
    const vm = machineCardVm(m) as unknown as Record<string, unknown>;
    expect(vm['cortexPath']).toBeUndefined();
    expect(vm['sshConfigured']).toBeUndefined();
    expect(vm['lastHeartbeat']).toBeUndefined();
    expect(vm['capabilities']).toBeUndefined();
  });
});
