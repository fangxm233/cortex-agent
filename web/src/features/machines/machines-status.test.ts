import { describe, expect, it } from 'vitest';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { machinesStatusTone } from './machines-status';

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
});

describe('machines status tone', () => {
  it('is green when every machine is online, amber when some are not, red when none are', () => {
    expect(machinesStatusTone([machine(true), machine(true)], true)).toBe('all');
    expect(machinesStatusTone([machine(true), machine(false)], true)).toBe('some');
    expect(machinesStatusTone([machine(false), machine(false)], true)).toBe('none');
  });

  it('has no tone while the roster is unknown or empty', () => {
    expect(machinesStatusTone([machine(true)], false)).toBe('unknown');
    expect(machinesStatusTone([], true)).toBe('unknown');
  });
});
