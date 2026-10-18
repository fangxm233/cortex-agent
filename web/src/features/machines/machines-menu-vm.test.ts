import { describe, expect, it } from 'vitest';
import type { MachineInfo } from '@cortex-agent/ui-contract';
import {
  machineHeartbeatText,
  machineMetaText,
  machinesChipLabel,
  machinesOnlineText,
  onlineMachineCount,
} from './machines-menu-vm';

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

describe('machines menu view-model', () => {
  it('counts only online machines', () => {
    expect(onlineMachineCount([machine(true), machine(false), machine(true)])).toBe(2);
  });

  it('labels the chip online/total and hides the total while loading', () => {
    expect(machinesChipLabel([machine(true), machine(false)], true)).toEqual({ online: '1', total: '/2' });
    expect(machinesChipLabel([], false)).toEqual({ online: '—', total: '' });
  });
});

describe('machine row text', () => {
  const now = Date.parse('2026-10-18T12:00:00.000Z');
  const live: MachineInfo = {
    ...machine(true), gpuCount: 2,
    connectedAt: '2026-10-18T11:30:00.000Z', lastHeartbeat: '2026-10-18T11:59:58.000Z',
  };

  it('counts the header in words and dashes it while loading', () => {
    expect(machinesOnlineText([machine(true), machine(false)], true, 'zh')).toBe('1/2 在线');
    expect(machinesOnlineText([], false, 'en')).toBe('—');
  });

  it('reads the heartbeat as an age, and drops it for an offline machine', () => {
    expect(machineHeartbeatText(live, 'en', now)).toBe('heartbeat 2s ago');
    expect(machineHeartbeatText(live, 'zh', now)).toBe('心跳 2秒前');
    expect(machineHeartbeatText(machine(false), 'en', now)).toBe('');
  });

  it('names the probed GPU model when known, else just GPU', () => {
    expect(machineMetaText(live, 'RTX 6000 Ada', 'en', now)).toBe('2 × RTX 6000 Ada · unix · connected 30m');
    expect(machineMetaText(live, null, 'zh', now)).toBe('2 × GPU · unix · 已连接 30分钟');
    expect(machineMetaText(machine(false), null, 'en', now)).toBe('unix');
  });
});
