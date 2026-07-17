// input:  handleMachinesList handler + mock deps
// output: machines.list query handler tests — online/offline/liveRuns at-least-one assertion each
// pos:    backend regression test for the machines.list read scope (plan §12 A item 1)
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first — isolates CORTEX_HOME
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { MachineInfo } from '../src/domain/ui-service/types.js';
import { handleMachinesList } from '../src/domain/ui-service/query/machines.js';

// ── minimal deps factory ──────────────────────────────────────────────────────

function makeDeps(overrides: {
  machines?: Record<string, { cortexPath: string; gpuCount: number; ssh?: string; win?: boolean }>;
  onlineDevices?: Array<{ device: string; platform: string; connectedAt: Date; lastHeartbeat: Date; capabilities: string[] }>;
  executions?: Array<{ status: string; dispatch?: { machine?: string } }>;
} = {}): any {
  return {
    clientRegistry: {
      getOnlineDevices: () => overrides.onlineDevices ?? [],
      isDeviceOnline: (device: string) =>
        (overrides.onlineDevices ?? []).some((d) => d.device === device),
      getMachineRegistry: () => overrides.machines ?? {},
    },
    executionRegistry: {
      getAll: () => overrides.executions ?? [],
      getExecution: () => null,
      cancelExecution: () => null,
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
  assert.strictEqual(m.liveRuns, 0);
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
  assert.strictEqual(m.liveRuns, 0);
});

test('machines.list: liveRuns counts only running executions on the named machine', async () => {
  const deps = makeDeps({
    machines: {
      'orchard': { cortexPath: '/home/user/.cortex', gpuCount: 4, ssh: 'user@orchard' },
    },
    onlineDevices: [],
    executions: [
      { status: 'running', dispatch: { machine: 'orchard' } },
      { status: 'running', dispatch: { machine: 'orchard' } },
      { status: 'completed', dispatch: { machine: 'orchard' } }, // completed, must not count
      { status: 'running', dispatch: { machine: 'other-host' } }, // different machine
      { status: 'running' }, // no dispatch.machine
    ],
  });

  const result: MachineInfo[] = await handleMachinesList(deps, {});

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].liveRuns, 2, 'only 2 running on this machine');
});

test('machines.list: windows machine returns os=windows', async () => {
  const deps = makeDeps({
    machines: {
      'mypc': { cortexPath: 'C:\\cortex', gpuCount: 1, ssh: 'user@mypc', win: true },
    },
  });

  const result: MachineInfo[] = await handleMachinesList(deps, {});

  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].os, 'windows');
});

test('machines.list: empty registry returns empty array', async () => {
  const deps = makeDeps({ machines: {} });
  const result = await handleMachinesList(deps, {});
  assert.deepStrictEqual(result, []);
});
