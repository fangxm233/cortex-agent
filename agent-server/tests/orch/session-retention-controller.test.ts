// input:  fake timers, settings callbacks, and retention controller deps
// output: controller startup, interval, debounce, singleflight, and stop tests
// pos:    Verifies retention controller lifecycle orchestration
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createSessionRetentionController } from '../../src/orchestration/session-retention-controller.js';

afterEach(() => {
  vi.useRealTimers();
});

test('retention controller runs on start, every 6h from completion, debounces settings, and stops cleanly', async () => {
  vi.useFakeTimers();
  const changed: string[][] = [];
  let unsubscribeCount = 0;
  let stopped = false;
  const runs: number[] = [];
  let resolveRun: (() => void) | null = null;
  const runGate = () => new Promise<void>((resolve) => { resolveRun = resolve; });
  const controller = createSessionRetentionController({
    getRetentionDays: () => 30,
    onSettingsChange: (cb) => {
      changed.push([]);
      const wrapper = (keys: string[]) => cb(keys);
      (controller as any)._testOnChange = wrapper;
      return () => { unsubscribeCount += 1; };
    },
    runSweep: async (days) => {
      runs.push(days);
      await runGate();
    },
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  });

  const startPromise = controller.start();
  assert.deepEqual(runs, [30]);
  resolveRun?.();
  await startPromise;

  vi.advanceTimersByTime(6 * 60 * 60 * 1000);
  await Promise.resolve();
  assert.deepEqual(runs, [30, 30]);
  resolveRun?.();
  await Promise.resolve();

  (controller as any)._testOnChange(['turnNotify']);
  vi.advanceTimersByTime(500);
  assert.deepEqual(runs, [30, 30]);

  (controller as any)._testOnChange(['sessionRetentionDays']);
  (controller as any)._testOnChange(['sessionRetentionDays']);
  vi.advanceTimersByTime(299);
  assert.deepEqual(runs, [30, 30]);
  vi.advanceTimersByTime(1);
  await Promise.resolve();
  assert.deepEqual(runs, [30, 30, 30]);
  resolveRun?.();
  await Promise.resolve();

  await controller.stop();
  assert.equal(unsubscribeCount, 1);
  stopped = true;
  vi.advanceTimersByTime(12 * 60 * 60 * 1000);
  assert.equal(stopped, true);
  assert.deepEqual(runs, [30, 30, 30]);
});

test('retention controller queues latest retention days while a sweep is in flight', async () => {
  vi.useFakeTimers();
  let changeHandler: ((keys: string[]) => void) | null = null;
  let retentionDays = 30;
  const runs: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = createSessionRetentionController({
    getRetentionDays: () => retentionDays,
    onSettingsChange: (cb) => {
      changeHandler = cb;
      return () => {};
    },
    runSweep: async (days) => {
      runs.push(days);
      if (runs.length === 1) await gate;
    },
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  });

  const startPromise = controller.start();
  assert.deepEqual(runs, [30]);
  retentionDays = 45;
  changeHandler?.(['sessionRetentionDays']);
  vi.advanceTimersByTime(300);
  retentionDays = 60;
  changeHandler?.(['sessionRetentionDays']);
  vi.advanceTimersByTime(300);
  assert.deepEqual(runs, [30]);

  release();
  await startPromise;
  await Promise.resolve();
  assert.deepEqual(runs, [30, 60]);
});

test('retention controller reports sweep errors and keeps scheduling future runs', async () => {
  vi.useFakeTimers();
  let changeHandler: ((keys: string[]) => void) | null = null;
  const runs: number[] = [];
  const errors: string[] = [];
  let failFirst = true;
  const controller = createSessionRetentionController({
    getRetentionDays: () => 30,
    onSettingsChange: (cb) => {
      changeHandler = cb;
      return () => {};
    },
    runSweep: async (days) => {
      runs.push(days);
      if (failFirst) {
        failFirst = false;
        throw new Error('boom');
      }
    },
    onError: (error) => { errors.push(error.message); },
    setTimeoutFn: setTimeout,
    clearTimeoutFn: clearTimeout,
  });

  await controller.start();
  assert.deepEqual(runs, [30]);
  assert.deepEqual(errors, ['boom']);

  vi.advanceTimersByTime(6 * 60 * 60 * 1000);
  await Promise.resolve();
  assert.deepEqual(runs, [30, 30]);

  changeHandler?.(['sessionRetentionDays']);
  vi.advanceTimersByTime(300);
  await Promise.resolve();
  assert.deepEqual(runs, [30, 30, 30]);
});
