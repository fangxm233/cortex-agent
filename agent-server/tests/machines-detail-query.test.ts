// input:  parseMachineProbe parser + handleMachineDetail handler with mock deps
// output: machines.detail tests — probe parsing, offline short-circuit, probe failure, live-run join
// pos:    backend regression test for the machines.detail live-probe read scope
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import './_test-home.js'; // MUST be first — isolates CORTEX_HOME
import { test } from 'vitest';
import assert from 'node:assert/strict';
import type { MachineDetail } from '../src/domain/ui-service/types.js';
import { handleMachineDetail } from '../src/domain/ui-service/query/machine-detail.js';
import { buildProbeCommand, parseMachineProbe } from '../src/domain/ui-service/query/machine-probe.js';

// ── fixtures ──────────────────────────────────────────────────────────────────

const FULL_PROBE = [
  '##GPU',
  '0, GPU-aaa, NVIDIA RTX 6000 Ada Generation, 62, 31200, 49140, 71, 280.15',
  '1, GPU-bbb, NVIDIA RTX 6000 Ada Generation, 0, 4, 49140, 38, 21.03',
  '##PROC',
  '41233, python, 30800, GPU-aaa',
  '41999, /usr/bin/blender, 400, GPU-aaa',
  '##SYS',
  'cores=64',
  'load1=3.21',
  'memTotalMb=257000',
  'memUsedMb=61000',
  'diskTotalKb=1000000000',
  'diskFreeKb=500000000',
  'uptimeSec=123456.78',
].join('\n');

function makeDeps(overrides: {
  machines?: Record<string, { cortexPath: string; gpuCount: number; ssh?: string; win?: boolean }>;
  online?: string[];
  executions?: any[];
  probeMachine?: (device: string, command: string, timeoutMs: number) => Promise<string>;
} = {}): any {
  return {
    clientRegistry: {
      getOnlineDevices: () => [],
      isDeviceOnline: (device: string) => (overrides.online ?? []).includes(device),
      getMachineRegistry: () => overrides.machines ?? {},
      probeMachine: overrides.probeMachine,
    },
    executionRegistry: {
      getAll: () => overrides.executions ?? [],
      getExecution: () => null,
      cancelExecution: () => null,
    },
  };
}

// ── parser ────────────────────────────────────────────────────────────────────

test('parseMachineProbe: parses per-GPU telemetry and joins compute processes by uuid', () => {
  const { gpus } = parseMachineProbe(FULL_PROBE);

  assert.strictEqual(gpus.length, 2);
  assert.deepStrictEqual(gpus[0], {
    index: 0,
    name: 'NVIDIA RTX 6000 Ada Generation',
    utilPercent: 62,
    memUsedMb: 31200,
    memTotalMb: 49140,
    tempC: 71,
    powerW: 280,
    processes: [
      { pid: '41233', name: 'python', memoryMb: 30800 },
      { pid: '41999', name: '/usr/bin/blender', memoryMb: 400 },
    ],
  });
  assert.deepStrictEqual(gpus[1].processes, [], 'GPU with no compute apps gets an empty list');
  assert.strictEqual(gpus[1].utilPercent, 0);
});

test('parseMachineProbe: parses host vitals into absolute units', () => {
  const { vitals } = parseMachineProbe(FULL_PROBE);

  assert.deepStrictEqual(vitals, {
    cpuCores: 64,
    loadAvg1: 3.21,
    memUsedMb: 61000,
    memTotalMb: 257000,
    diskFreeGb: 500000000 / (1024 * 1024),
    diskTotalGb: 1000000000 / (1024 * 1024),
    uptimeSec: 123456,
  });
});

test('parseMachineProbe: a host without nvidia-smi yields no GPUs but keeps vitals', () => {
  const raw = ['##GPU', '##PROC', '##SYS', 'cores=8', 'load1=0.10'].join('\n');
  const { gpus, vitals } = parseMachineProbe(raw);

  assert.deepStrictEqual(gpus, []);
  assert.strictEqual(vitals.cpuCores, 8);
  assert.strictEqual(vitals.loadAvg1, 0.1);
  assert.strictEqual(vitals.memTotalMb, null, 'absent keys stay null rather than 0');
  assert.strictEqual(vitals.diskFreeGb, null);
});

test('parseMachineProbe: drops graphics processes that report no compute memory', () => {
  // Windows hosts list every desktop app under --query-compute-apps with used_memory `[N/A]`.
  // They hold no attributable VRAM, so counting them as 0 MB compute processes would be noise.
  const raw = [
    '##GPU',
    '0, GPU-aaa, NVIDIA GeForce RTX 4060 Ti, 38, 3135, 8188, 44, 25.09',
    '##PROC',
    '2108, C:\\Windows\\System32\\dwm.exe, [N/A], GPU-aaa',
    '41233, python, 30800, GPU-aaa',
  ].join('\n');

  const { gpus } = parseMachineProbe(raw);

  assert.deepStrictEqual(gpus[0].processes, [{ pid: '41233', name: 'python', memoryMb: 30800 }]);
});

test('parseMachineProbe: empty values and malformed lines degrade to null without throwing', () => {
  // Windows/git-bash shape: nproc and /proc/loadavg missing → the shell emits bare `key=`.
  const raw = ['##GPU', 'garbage line', '##PROC', 'junk', '##SYS', 'cores=', 'load1=', 'uptimeSec='].join('\n');
  const { gpus, vitals } = parseMachineProbe(raw);

  assert.deepStrictEqual(gpus, [], 'a GPU line with too few fields is dropped');
  assert.strictEqual(vitals.cpuCores, null);
  assert.strictEqual(vitals.loadAvg1, null);
  assert.strictEqual(vitals.uptimeSec, null);
});

test('buildProbeCommand: single-quotes the cortexPath so registry values cannot break out', () => {
  const command = buildProbeCommand("/home/o'brien/.cortex");

  assert.ok(command.includes(`'/home/o'\\''brien/.cortex'`), 'embedded quote is escaped');
  assert.ok(command.includes('##GPU') && command.includes('##SYS'), 'section markers are emitted');
});

// ── handler ───────────────────────────────────────────────────────────────────

test('machines.detail: offline machine short-circuits without probing', async () => {
  let probed = false;
  const deps = makeDeps({
    machines: { nimbus: { cortexPath: '/home/user/.cortex', gpuCount: 2 } },
    online: [],
    probeMachine: async () => {
      probed = true;
      return FULL_PROBE;
    },
  });

  const result: MachineDetail = await handleMachineDetail(deps, { machine: 'nimbus' });

  assert.strictEqual(probed, false, 'no RPC round trip to an offline device');
  assert.strictEqual(result.online, false);
  assert.strictEqual(result.vitals, null);
  assert.deepStrictEqual(result.gpus, []);
  assert.strictEqual(result.probedAt, null);
  assert.strictEqual(result.probeError, null);
});

test('machines.detail: online machine returns parsed probe with probedAt set', async () => {
  const deps = makeDeps({
    machines: { atlas: { cortexPath: '/home/user/.cortex', gpuCount: 2 } },
    online: ['atlas'],
    probeMachine: async () => FULL_PROBE,
  });

  const result = await handleMachineDetail(deps, { machine: 'atlas' });

  assert.strictEqual(result.online, true);
  assert.strictEqual(result.gpus.length, 2);
  assert.strictEqual(result.vitals?.cpuCores, 64);
  assert.strictEqual(result.probeError, null);
  assert.ok(result.probedAt && !Number.isNaN(Date.parse(result.probedAt)), 'probedAt is an ISO timestamp');
});

test('machines.detail: a failed probe surfaces probeError instead of throwing', async () => {
  const deps = makeDeps({
    machines: { atlas: { cortexPath: '/home/user/.cortex', gpuCount: 2 } },
    online: ['atlas'],
    probeMachine: async () => {
      throw new Error('Command to "atlas" timed out after 15s');
    },
  });

  const result = await handleMachineDetail(deps, { machine: 'atlas' });

  assert.strictEqual(result.online, true, 'a probe timeout does not mark the device offline');
  assert.strictEqual(result.vitals, null);
  assert.deepStrictEqual(result.gpus, []);
  assert.strictEqual(result.probedAt, null);
  assert.match(result.probeError ?? '', /timed out/);
});

test('machines.detail: liveRuns lists running dispatches on this machine with their GPU indices', async () => {
  const deps = makeDeps({
    machines: { orchard: { cortexPath: '/home/user/.cortex', gpuCount: 4 } },
    online: [],
    executions: [
      {
        id: 'exec_1', status: 'running', project: 'dexhand',
        dispatch: { machine: 'orchard', taskId: 'a3f1', runName: 'exp-042' },
        gpu: { indices: [0, 1], memoryMb: 49140 },
        runtime: { startedAt: '2026-08-03T10:00:00.000Z' },
      },
      {
        id: 'exec_2', status: 'completed', project: 'dexhand',
        dispatch: { machine: 'orchard', taskId: 'bbbb', runName: 'old' },
        gpu: null, runtime: { startedAt: '2026-08-03T09:00:00.000Z' },
      },
      {
        id: 'exec_3', status: 'running', project: 'other',
        dispatch: { machine: 'elsewhere', taskId: 'cccc', runName: 'nope' },
        gpu: null, runtime: { startedAt: '2026-08-03T10:00:00.000Z' },
      },
      { id: 'exec_4', status: 'running', project: 'p', dispatch: null, gpu: null, runtime: null },
    ],
  });

  const result = await handleMachineDetail(deps, { machine: 'orchard' });

  assert.deepStrictEqual(result.liveRuns, [
    {
      executionId: 'exec_1',
      taskId: 'a3f1',
      runName: 'exp-042',
      project: 'dexhand',
      gpuIndices: [0, 1],
      startedAt: '2026-08-03T10:00:00.000Z',
    },
  ]);
});

test('machines.detail: an online machine with no probe transport reports it as a probe error', async () => {
  const deps = makeDeps({
    machines: { atlas: { cortexPath: '/home/user/.cortex', gpuCount: 2 } },
    online: ['atlas'],
  });

  const result = await handleMachineDetail(deps, { machine: 'atlas' });

  assert.strictEqual(result.online, true);
  assert.ok(result.probeError, 'missing transport is reported, not silently empty');
});

test('machines.detail: an unregistered machine name is rejected', async () => {
  const deps = makeDeps({ machines: {} });
  await assert.rejects(() => handleMachineDetail(deps, { machine: 'ghost' }), /ghost/);
});
