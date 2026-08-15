// input:  boot job registration helpers and fake timers
// output: client reload and store archive settings guard tests
// pos:    Verifies optional boot jobs arm only when enabled
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { startClientHotReloadJob, startStoreArchiveJob } from '../../src/entry/boot-jobs.js';

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

test('disabled client hot reload starts remote clients without arming the probe timer', () => {
  vi.useFakeTimers();
  const runProbe = vi.fn();
  const startAllRemoteClients = vi.fn();

  startClientHotReloadJob(false, runProbe, startAllRemoteClients);

  assert.equal(vi.getTimerCount(), 0);
  assert.equal(runProbe.mock.calls.length, 0);
  assert.equal(startAllRemoteClients.mock.calls.length, 1);
});

test('enabled client hot reload preserves the delayed probe then remote-client startup', async () => {
  vi.useFakeTimers();
  const order: string[] = [];
  const runProbe = vi.fn(async () => { order.push('probe'); });
  const startAllRemoteClients = vi.fn(async () => { order.push('clients'); });

  startClientHotReloadJob(true, runProbe, startAllRemoteClients);

  assert.equal(vi.getTimerCount(), 1);
  assert.equal(runProbe.mock.calls.length, 0);
  await vi.advanceTimersByTimeAsync(2_000);
  assert.deepEqual(order, ['probe', 'clients']);
});

test('store archive setting controls whether the daily interval is armed', async () => {
  vi.useFakeTimers();
  const runArchive = vi.fn().mockResolvedValue(undefined);

  startStoreArchiveJob(false, runArchive);
  assert.equal(vi.getTimerCount(), 0);

  startStoreArchiveJob(true, runArchive);
  assert.equal(vi.getTimerCount(), 1);
  await vi.advanceTimersByTimeAsync(DAY_MS);
  assert.equal(runArchive.mock.calls.length, 1);
});
