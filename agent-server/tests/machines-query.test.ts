import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { MachineInfo } from '../src/domain/ui-service/types.js';
import { handleMachinesList } from '../src/domain/ui-service/query/machines.js';

// ── minimal deps factory ──────────────────────────────────────────────────────

function makeDeps(overrides: {
  machines?: Record<string, { cortexPath: string; gpuCount: number; ssh?: string; win?: boolean }>;
  onlineDevices?: Array<{ device: string; platform: string; connectedAt: Date; lastHeartbeat: Date; capabilities: string[] }>;
} = {}): any {
  return {
    clientRegistry: {
      getOnlineDevices: () => overrides.onlineDevices ?? [],
      isDeviceOnline: (device: string) =>
        (overrides.onlineDevices ?? []).some((d) => d.device === device),
      getMachineRegistry: () => overrides.machines ?? {},
    },
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('machines.list: online machine returns online=true with timestamps and capabilities', async () => {
  const connectedAt = new Date('2026-07-10T10:00:00.000Z');
  const lastHeartbeat = new Date('2026-07-10T10:05:00.000Z');

  const deps = makeDeps({
    machines: {
      'atlas': { cortexPath: '/home/user/.cortex', gpuCount: 2, ssh: 'user@atlas', win: false },
    },
    onlineDevices: [
      { device: 'atlas', platform: 'linux', connectedAt, lastHeartbeat, capabilities: ['bash', 'gpu'] },
    ],
  });

  const result: MachineInfo[] = await handleMachinesList(deps, {});

  assert.strictEqual(result.length, 1);
  const m = result[0];
  assert.strictEqual(m.name, 'atlas');
  assert.strictEqual(m.online, true);
  assert.strictEqual(m.connectedAt, '2026-07-10T10:00:00.000Z');
  assert.strictEqual(m.lastHeartbeat, '2026-07-10T10:05:00.000Z');
  assert.deepStrictEqual(m.capabilities, ['bash', 'gpu']);
  assert.strictEqual(m.cortexPath, '/home/user/.cortex');
  assert.strictEqual(m.gpuCount, 2);
  assert.strictEqual(m.sshConfigured, true);
  assert.strictEqual(m.os, 'unix');
});

test('machines.list: offline machine returns online=false with null timestamps and empty capabilities', async () => {
  const deps = makeDeps({
    machines: {
      'nimbus': { cortexPath: '/home/user/.cortex', gpuCount: 0, win: false },
    },
    onlineDevices: [],
  });

  const result: MachineInfo[] = await handleMachinesList(deps, {});

  assert.strictEqual(result.length, 1);
  const m = result[0];
  assert.strictEqual(m.name, 'nimbus');
  assert.strictEqual(m.online, false);
  assert.strictEqual(m.connectedAt, null);
  assert.strictEqual(m.lastHeartbeat, null);
  assert.deepStrictEqual(m.capabilities, []);
  assert.strictEqual(m.sshConfigured, false);
});

