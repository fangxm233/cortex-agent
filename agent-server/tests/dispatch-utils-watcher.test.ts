// input:  machines.json and a failing fs.watch implementation
// output: machine-registry polling fallback regression
// pos:    Machine config watcher failure-path test
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { CONFIG_DIR } from '../src/core/paths.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    watch: vi.fn(() => { throw new Error('watch unavailable'); }),
  };
});

const MACHINES_FILE = path.join(CONFIG_DIR, 'machines.json');
const INITIAL = { local: { cortexPath: '/workspace/initial', gpuCount: 1 } };
const UPDATED = { local: { cortexPath: '/workspace/updated', gpuCount: 2 } };

afterEach(() => vi.useRealTimers());

test('machine registry validates SSH reverse-route fields', async () => {
  const registry = await import('../src/domain/tasks/dispatch-utils.js');
  assert.doesNotThrow(() => registry.validateMachineEntry('worker', {
    cortexPath: '/workspace', gpuCount: 1, ssh: 'user@worker',
    clientConnection: 'ssh-reverse', clientReversePort: 13002,
  }));
  assert.throws(() => registry.validateMachineEntry('worker', {
    cortexPath: '/workspace', gpuCount: 1, clientConnection: 'ssh-reverse',
  }), /requires ssh/);
  assert.throws(() => registry.validateMachineEntry('worker', {
    cortexPath: '/workspace', gpuCount: 1, ssh: 'user@worker',
    clientConnection: 'ssh-reverse', clientReversePort: 22,
  }), /1024\.\.65535/);
  assert.throws(() => registry.validateMachineEntry('worker', {
    cortexPath: '/workspace', gpuCount: 1, ssh: 'user@worker',
    clientConnection: 'other' as 'direct',
  }), /clientConnection/);
});

test('machine registry polls after fs.watch creation fails', async () => {
  vi.useFakeTimers();
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(MACHINES_FILE, JSON.stringify(INITIAL));
  const registry = await import('../src/domain/tasks/dispatch-utils.js');
  registry.loadMachinesFromFile();
  assert.equal(registry.getMachineRegistry().local.cortexPath, '/workspace/initial');

  registry.startMachineRegistryWatcher();
  try {
    await fs.writeFile(MACHINES_FILE, JSON.stringify(UPDATED));
    await vi.advanceTimersByTimeAsync(5_300);

    assert.deepEqual(registry.getMachineRegistry(), UPDATED);
  } finally {
    registry.stopMachineRegistryWatcher();
  }
});
