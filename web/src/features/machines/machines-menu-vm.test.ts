import { describe, expect, it } from 'vitest';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { machinesChipLabel, onlineMachineCount } from './machines-menu-vm';

const machine = (online: boolean): MachineInfo => ({
  name: online ? 'atlas' : 'nimbus',
  cortexPath: null,
  gpuCount: null,
  sshConfigured: false,
  os: 'unix',
  online,
  connectedAt: null,
  lastHeartbeat: null,
  capabilities: [],
  liveRuns: 0,
});

describe('machines menu view-model', () => {
  it('counts only online machines', () => {
    expect(onlineMachineCount([machine(true), machine(false), machine(true)])).toBe(2);
  });

  it('labels the chip online/total and hides the total while loading', () => {
    expect(machinesChipLabel([machine(true), machine(false)], true)).toEqual({ online: '1', total: '/2' });
    expect(machinesChipLabel([], false)).toEqual({ online: '—', total: '' });
  });
});
