import { describe, expect, it } from 'vitest';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import { onlineMachineCount } from './right-panel-vm';

describe('onlineMachineCount — Machines tab badge counts ONLINE only, not total', () => {
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
  it('counts only online machines', () => {
    expect(onlineMachineCount([machine(true), machine(false), machine(true)])).toBe(2);
  });
});
