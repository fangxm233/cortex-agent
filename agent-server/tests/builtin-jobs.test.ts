// input:  fake timers, mutable settings, built-in job services
// output: registration, timer, serial, and shutdown tests
// pos:    Verifies settings-backed built-in periodic jobs
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test, vi } from 'vitest';
import type { PlatformAdapter } from '../src/platform/index.js';

const builtinHarness = vi.hoisted(() => ({
  callbacks: new Set<(keys: string[]) => void>(),
  collect: vi.fn<() => Promise<unknown[]>>(),
  settings: {
    taskDispatchEnabled: false,
    taskDispatchIntervalMs: 30_000,
    taskArchiveEnabled: false,
    taskArchiveIntervalMs: 21_600_000,
    memoryIndexRegenEnabled: false,
    memoryIndexRegenIntervalMs: 86_400_000,
    providerUsageCollectionEnabled: true,
    providerUsageCollectionIntervalMs: 300_000,
  },
}));

vi.mock('../src/core/settings.js', () => ({
  getSettings: () => builtinHarness.settings,
  onSettingsChange: (callback: (keys: string[]) => void) => {
    builtinHarness.callbacks.add(callback);
    return () => builtinHarness.callbacks.delete(callback);
  },
}));
vi.mock('../src/domain/costs/usage-service.js', () => ({
  usageService: { collect: builtinHarness.collect },
}));

import { createBuiltinJobController } from '../src/domain/scheduling/builtin-job-controller.js';
import { startBuiltinJobs, stopBuiltinJobs } from '../src/domain/scheduling/builtin-jobs.js';

const settings: Record<string, boolean | number> = {
  serialEnabled: true,
  serialIntervalMs: 2_000,
  detachedEnabled: true,
  detachedIntervalMs: 1_000,
};
const callbacks = new Set<(keys: string[]) => void>();

function notify(...keys: string[]): void {
  for (const callback of callbacks) callback(keys);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function notifyBuiltin(...keys: string[]): void {
  for (const callback of builtinHarness.callbacks) callback(keys);
}

beforeEach(async () => {
  await stopBuiltinJobs();
  vi.useFakeTimers();
  settings.serialEnabled = true;
  settings.serialIntervalMs = 2_000;
  settings.detachedEnabled = true;
  settings.detachedIntervalMs = 1_000;
  callbacks.clear();
  builtinHarness.callbacks.clear();
  builtinHarness.collect.mockReset();
  builtinHarness.settings.providerUsageCollectionEnabled = true;
  builtinHarness.settings.providerUsageCollectionIntervalMs = 300_000;
});

afterEach(async () => {
  await stopBuiltinJobs();
  callbacks.clear();
  builtinHarness.callbacks.clear();
  vi.useRealTimers();
});

test('provider usage collection is serial and awaited at shutdown', async () => {
  const first = deferred();
  const second = deferred();
  builtinHarness.collect
    .mockReturnValueOnce(first.promise.then(() => []))
    .mockReturnValueOnce(second.promise.then(() => []));

  startBuiltinJobs({} as PlatformAdapter);
  await vi.advanceTimersByTimeAsync(0);
  builtinHarness.settings.providerUsageCollectionIntervalMs = 5_000;
  notifyBuiltin('providerUsageCollectionIntervalMs');
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(builtinHarness.collect.mock.calls.length, 1, 'collection runs must not overlap');

  first.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(5_000);
  assert.equal(builtinHarness.collect.mock.calls.length, 2);
  let stopped = false;
  const stopping = stopBuiltinJobs().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, 'shutdown must await active collection');
  second.resolve();
  await stopping;
});

test('provider usage settings reschedule, disable, and re-enable collection', async () => {
  builtinHarness.collect.mockResolvedValue([]);
  builtinHarness.settings.providerUsageCollectionEnabled = false;
  startBuiltinJobs({} as PlatformAdapter);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(builtinHarness.collect.mock.calls.length, 0);

  builtinHarness.settings.providerUsageCollectionEnabled = true;
  notifyBuiltin('providerUsageCollectionEnabled');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(builtinHarness.collect.mock.calls.length, 1, 're-enabled collection runs immediately');

  builtinHarness.settings.providerUsageCollectionIntervalMs = 7_000;
  notifyBuiltin('providerUsageCollectionIntervalMs');
  await vi.advanceTimersByTimeAsync(6_999);
  assert.equal(builtinHarness.collect.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(builtinHarness.collect.mock.calls.length, 2, 'interval changes reschedule collection');

  builtinHarness.settings.providerUsageCollectionEnabled = false;
  notifyBuiltin('providerUsageCollectionEnabled');
  await vi.advanceTimersByTimeAsync(20_000);
  assert.equal(builtinHarness.collect.mock.calls.length, 2, 'disabled collection stays stopped');
});

test('enabled jobs run immediately and detached ticks recur without awaiting work', async () => {
  const serialRun = vi.fn().mockResolvedValue(undefined);
  const detachedRun = vi.fn();
  const controller = createBuiltinJobController({
    getSettings: () => settings,
    onSettingsChange: (callback) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    jobs: [
      { name: 'serial', enabledKey: 'serialEnabled', intervalKey: 'serialIntervalMs', mode: 'serial', run: serialRun },
      { name: 'detached', enabledKey: 'detachedEnabled', intervalKey: 'detachedIntervalMs', mode: 'detached', run: detachedRun },
    ],
  });

  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(serialRun.mock.calls.length, 1);
  assert.equal(detachedRun.mock.calls.length, 1);

  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(detachedRun.mock.calls.length, 2);
  assert.equal(serialRun.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(1_000);
  assert.equal(serialRun.mock.calls.length, 2);

  await controller.stop();
});

test('serial jobs never overlap and pick up interval changes after completion', async () => {
  const first = deferred();
  const serialRun = vi.fn()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(undefined);
  const controller = createBuiltinJobController({
    getSettings: () => settings,
    onSettingsChange: (callback) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    jobs: [
      { name: 'serial', enabledKey: 'serialEnabled', intervalKey: 'serialIntervalMs', mode: 'serial', run: serialRun },
    ],
  });

  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(serialRun.mock.calls.length, 1);
  settings.serialIntervalMs = 5_000;
  notify('serialIntervalMs');
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(serialRun.mock.calls.length, 1, 'an in-flight serial job cannot overlap');

  first.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(4_999);
  assert.equal(serialRun.mock.calls.length, 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.equal(serialRun.mock.calls.length, 2);

  await controller.stop();
});

test('disable cancels future work and re-enable runs immediately without duplicating in-flight serial work', async () => {
  const first = deferred();
  const serialRun = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const controller = createBuiltinJobController({
    getSettings: () => settings,
    onSettingsChange: (callback) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    jobs: [
      { name: 'serial', enabledKey: 'serialEnabled', intervalKey: 'serialIntervalMs', mode: 'serial', run: serialRun },
    ],
  });

  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  settings.serialEnabled = false;
  notify('serialEnabled');
  settings.serialEnabled = true;
  notify('serialEnabled');
  await vi.advanceTimersByTimeAsync(0);
  assert.equal(serialRun.mock.calls.length, 1);

  first.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(2_000);
  assert.equal(serialRun.mock.calls.length, 2);

  settings.serialEnabled = false;
  notify('serialEnabled');
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(serialRun.mock.calls.length, 2);
  await controller.stop();
});

test('stop clears timers, unsubscribes, and waits for active serial work', async () => {
  const active = deferred();
  const serialRun = vi.fn().mockReturnValue(active.promise);
  const controller = createBuiltinJobController({
    getSettings: () => settings,
    onSettingsChange: (callback) => { callbacks.add(callback); return () => callbacks.delete(callback); },
    jobs: [
      { name: 'serial', enabledKey: 'serialEnabled', intervalKey: 'serialIntervalMs', mode: 'serial', run: serialRun },
    ],
  });

  controller.start();
  await vi.advanceTimersByTimeAsync(0);
  let stopped = false;
  const stopping = controller.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.equal(callbacks.size, 0);

  active.resolve();
  await stopping;
  assert.equal(stopped, true);
  await vi.advanceTimersByTimeAsync(10_000);
  assert.equal(serialRun.mock.calls.length, 1);
});
