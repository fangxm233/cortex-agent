// input:  Node test runner + task-dispatcher + dispatch/parser
// output: per-GPU slot scheduling regression tests
// pos:    Verify GPU slot occupancy/gpu_count parsing and injection
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll } from 'vitest';
import assert from 'node:assert/strict';
import { checkRealGpuOccupancy, filterDispatchableTasks } from '../src/domain/tasks/dispatcher.js';
import { _testSetRegistry } from '../src/domain/tasks/dispatch-utils.js';

beforeAll(() => {
  _testSetRegistry({ testbox: { cortexPath: '/tmp/test', gpuCount: 2 } });
});

// --- checkRealGpuOccupancy per-GPU structure ---

test('checkRealGpuOccupancy returns per-GPU structure with freeIndices', async () => {
  // We can't call the real nvidia-smi in tests, but we test the return structure
  // by injecting a mock. For now, test that the function exists and handles unknown machines.
  const result = await checkRealGpuOccupancy('nonexistent-machine');
  // Unknown machine should return allOccupied: false with empty gpus array
  assert.equal(result.allOccupied, false);
  assert.ok(Array.isArray(result.freeIndices));
  assert.ok(Array.isArray(result.gpus));
});

// --- filterDispatchableTasks slot logic ---

test('filterDispatchableTasks allows GPU task when machine has free slots (count-based)', async () => {
  const tasks = [
    { id: 'a1', project: 'proj', text: 'gpu task', gpu: 'testbox', gpu_count: 1, template: 'default' },
  ];
  // gpuBusyCounts: testbox has 1 in-progress GPU task, but testbox has 2 GPUs total
  const gpuBusyCounts = new Map([['testbox', 1]]);

  const filtered = await filterDispatchableTasks(tasks, 'sched-1', gpuBusyCounts, {
    findActiveDispatchMatch: () => null,
    checkRealGpuOccupancy: async () => ({
      gpus: [
        { index: 0, occupied: false, memUsedMB: 166, memTotalMB: 49140, processes: [] },
        { index: 1, occupied: true, memUsedMB: 22807, memTotalMB: 49140, processes: [{ pid: '123', name: 'python', memoryMB: 22807 }] },
      ],
      freeIndices: [0],
      allOccupied: false,
    }),
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'a1');
  assert.equal(filtered[0]._assignedGpuIndex, 0);
});

test('filterDispatchableTasks blocks GPU task when all slots occupied', async () => {
  const tasks = [
    { id: 'a1', project: 'proj', text: 'gpu task', gpu: 'testbox', gpu_count: 1, template: 'default' },
  ];
  const gpuBusyCounts = new Map([['testbox', 2]]);

  const filtered = await filterDispatchableTasks(tasks, 'sched-1', gpuBusyCounts, {
    findActiveDispatchMatch: () => null,
    checkRealGpuOccupancy: async () => ({
      gpus: [
        { index: 0, occupied: true, memUsedMB: 30000, memTotalMB: 49140, processes: [{ pid: '100', name: 'python', memoryMB: 30000 }] },
        { index: 1, occupied: true, memUsedMB: 22807, memTotalMB: 49140, processes: [{ pid: '200', name: 'python', memoryMB: 22807 }] },
      ],
      freeIndices: [],
      allOccupied: true,
    }),
  });

  assert.equal(filtered.length, 0);
});

test('filterDispatchableTasks blocks multi-GPU task when not enough free slots', async () => {
  const tasks = [
    { id: 'a1', project: 'proj', text: 'ddp training', gpu: 'testbox', gpu_count: 2, template: 'default' },
  ];
  // 1 slot already in use, task needs 2, machine has 2 total → only 1 free
  const gpuBusyCounts = new Map([['testbox', 1]]);

  const filtered = await filterDispatchableTasks(tasks, 'sched-1', gpuBusyCounts, {
    findActiveDispatchMatch: () => null,
    checkRealGpuOccupancy: async () => ({
      gpus: [
        { index: 0, occupied: false, memUsedMB: 166, memTotalMB: 49140, processes: [] },
        { index: 1, occupied: true, memUsedMB: 22807, memTotalMB: 49140, processes: [{ pid: '123', name: 'python', memoryMB: 22807 }] },
      ],
      freeIndices: [0],
      allOccupied: false,
    }),
  });

  assert.equal(filtered.length, 0);
});

test('filterDispatchableTasks allows multi-GPU task when enough free slots', async () => {
  const tasks = [
    { id: 'a1', project: 'proj', text: 'ddp training', gpu: 'testbox', gpu_count: 2, template: 'default' },
  ];
  const gpuBusyCounts = new Map(); // no in-progress GPU tasks

  const filtered = await filterDispatchableTasks(tasks, 'sched-1', gpuBusyCounts, {
    findActiveDispatchMatch: () => null,
    checkRealGpuOccupancy: async () => ({
      gpus: [
        { index: 0, occupied: false, memUsedMB: 166, memTotalMB: 49140, processes: [] },
        { index: 1, occupied: false, memUsedMB: 100, memTotalMB: 49140, processes: [] },
      ],
      freeIndices: [0, 1],
      allOccupied: false,
    }),
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]._assignedGpuIndex, '0,1');
});

test('filterDispatchableTasks backward-compatible: task without gpu_count defaults to 1', async () => {
  const tasks = [
    { id: 'a1', project: 'proj', text: 'old gpu task', gpu: 'testbox', template: 'default' },
  ];
  const gpuBusyCounts = new Map();

  const filtered = await filterDispatchableTasks(tasks, 'sched-1', gpuBusyCounts, {
    findActiveDispatchMatch: () => null,
    checkRealGpuOccupancy: async () => ({
      gpus: [
        { index: 0, occupied: false, memUsedMB: 166, memTotalMB: 49140, processes: [] },
        { index: 1, occupied: false, memUsedMB: 100, memTotalMB: 49140, processes: [] },
      ],
      freeIndices: [0, 1],
      allOccupied: false,
    }),
  });

  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]._assignedGpuIndex, 0);
});

test('filterDispatchableTasks deducts assigned GPU indices from cache (no double-assign)', async () => {
  const tasks = [
    { id: 'a1', project: 'proj', text: 'gpu task 1', gpu: 'testbox', gpu_count: 1, template: 'default' },
    { id: 'b2', project: 'proj', text: 'gpu task 2', gpu: 'testbox', gpu_count: 1, template: 'default' },
  ];
  const gpuBusyCounts = new Map(); // no in-progress GPU tasks

  const filtered = await filterDispatchableTasks(tasks, 'sched-1', gpuBusyCounts, {
    findActiveDispatchMatch: () => null,
    checkRealGpuOccupancy: async () => ({
      gpus: [
        { index: 0, occupied: false, memUsedMB: 166, memTotalMB: 49140, processes: [] },
        { index: 1, occupied: true, memUsedMB: 22807, memTotalMB: 49140, processes: [{ pid: '123', name: 'python', memoryMB: 22807 }] },
      ],
      freeIndices: [0],
      allOccupied: false,
    }),
  });

  // Only 1 free GPU slot — second task must be blocked
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'a1');
  assert.equal(filtered[0]._assignedGpuIndex, 0);
});

// --- Existing tests still work (backward compat) ---

test('filterDispatchableTasks accepts tasks without device tag (device tag removed)', async () => {
  const tasks = [
    { id: 'a1', project: 'proj', text: 'no device no gpu', gpu: null, template: 'default' },
    { id: 'b2', project: 'proj', text: 'has gpu', gpu: 'testbox', template: 'default' },
  ];

  const filtered = await filterDispatchableTasks(tasks, 'sched-1', new Map(), {
    findActiveDispatchMatch: () => null,
    checkRealGpuOccupancy: async () => ({
      gpus: [{ index: 0, occupied: false, memUsedMB: 166, memTotalMB: 49140, processes: [] }],
      freeIndices: [0],
      allOccupied: false,
    }),
  });

  assert.deepEqual(filtered.map(t => t.id), ['a1', 'b2']);
});
