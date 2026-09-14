import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { startClientHotReloadJob, startStoreArchiveJob } from '../../src/entry/boot-jobs.js';

const DAY_MS = 24 * 60 * 60 * 1000;

afterEach(() => {
  vi.useRealTimers();
});

test('disabled client hot reload starts remote clients without initializing the publisher', () => {
  const initHotReload = vi.fn();
  const startAllRemoteClients = vi.fn().mockResolvedValue(undefined);

  startClientHotReloadJob(false, initHotReload, startAllRemoteClients);

  assert.equal(initHotReload.mock.calls.length, 0);
  assert.equal(startAllRemoteClients.mock.calls.length, 1);
});

test('enabled client hot reload initializes the publisher before starting remote clients', () => {
  const order: string[] = [];
  const initHotReload = vi.fn(() => { order.push('init'); });
  const startAllRemoteClients = vi.fn(async () => { order.push('clients'); });

  startClientHotReloadJob(true, initHotReload, startAllRemoteClients);

  assert.deepEqual(order, ['init', 'clients']);
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
