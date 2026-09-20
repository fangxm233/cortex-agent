// input:  a temp-home machines.json + client-reported gpu counts
// output: assertions on registry/file reconciliation and refusal cases
// pos:    Covers applyReportedGpuCount (client hello → machines.json)
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, test } from 'vitest';
import { CONFIG_DIR } from '../src/core/paths.js';

const MACHINES_FILE = path.join(CONFIG_DIR, 'machines.json');

const BASE = {
  worker: { cortexPath: '/home/a/Cortex', gpuCount: 2 },
  'desk': { cortexPath: 'D:\\Cortex', gpuCount: 0, ssh: 'user@desk', win: true },
};

async function loadRegistry() {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(MACHINES_FILE, JSON.stringify(BASE, null, 2));
  const registry = await import('../src/domain/tasks/dispatch-utils.js');
  registry.loadMachinesFromFile();
  return registry;
}

async function readMachinesFile(): Promise<any> {
  return JSON.parse(await fs.readFile(MACHINES_FILE, 'utf-8'));
}

let registry: Awaited<ReturnType<typeof loadRegistry>>;

beforeEach(async () => {
  registry = await loadRegistry();
});

test('a differing client-reported count updates memory and machines.json', async () => {
  assert.equal(registry.applyReportedGpuCount('desk', 2), 'updated');
  assert.equal(registry.getMachineRegistry()['desk'].gpuCount, 2);

  const onDisk = await readMachinesFile();
  assert.equal(onDisk['desk'].gpuCount, 2);
  // Every other field of the entry survives the rewrite.
  assert.equal(onDisk['desk'].ssh, 'user@desk');
  assert.equal(onDisk['desk'].win, true);
  assert.equal(onDisk['desk'].cortexPath, 'D:\\Cortex');
  // Other machines are untouched.
  assert.deepEqual(onDisk.worker, BASE.worker);
});

test('a matching count is a no-op', async () => {
  assert.equal(registry.applyReportedGpuCount('worker', 2), 'unchanged');
  assert.deepEqual(await readMachinesFile(), BASE);
});

test('null (probe failed) keeps the configured count', async () => {
  assert.equal(registry.applyReportedGpuCount('desk', null), 'skipped');
  assert.equal(registry.getMachineRegistry()['desk'].gpuCount, 0);
  assert.deepEqual(await readMachinesFile(), BASE);
});

test('an unknown device cannot create or edit a registry entry', async () => {
  assert.equal(registry.applyReportedGpuCount('stranger', 8), 'skipped');
  assert.deepEqual(await readMachinesFile(), BASE);
});

test('implausible values are refused', async () => {
  for (const bad of [-1, 1.5, 999, Number.NaN]) {
    assert.equal(registry.applyReportedGpuCount('desk', bad), 'skipped');
  }
  assert.deepEqual(await readMachinesFile(), BASE);
});
