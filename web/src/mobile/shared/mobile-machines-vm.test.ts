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
  it('sets connectedAt to null when offline (even if DTO has a stale value)', () => {
    // DTO may still carry a stale connectedAt from the last session — we hide it when offline
    const m = mk({ name: 'lab', online: false, connectedAt: '2026-07-09T08:00:00Z' });
    expect(machineCardVm(m).connectedAt).toBeNull();
  });
});
