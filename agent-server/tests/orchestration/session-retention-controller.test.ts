import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createSessionRetentionController } from '../../src/orchestration/session-retention-controller.js';

afterEach(() => {
  vi.useRealTimers();
});

/** Let a settled sweep promise run its continuation (loop exit, next-run scheduling). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

test('retention controller runs on start, every 6h from completion, debounces settings, and stops cleanly', async () => {
  vi.useFakeTimers();
  let unsubscribeCount = 0;
  const runs: number[] = [];
  let resolveRun: (() => void) | null = null;
  const runGate = () => new Promise<void>((resolve) => { resolveRun = resolve; });
  const controller = createSessionRetentionController({
    getRetentionDays: () => 30,
    onSettingsChange: (cb) => {
      const wrapper = (keys: string[]) => cb(keys);
      (controller as any)._testOnChange = wrapper;
      return () => { unsubscribeCount += 1; };
    },
    runSweep: async (days) => {
      runs.push(days);
      await runGate();
    },
  });

  controller.start();
  assert.deepEqual(runs, [30]);
  resolveRun?.();
  await settle();

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
  vi.advanceTimersByTime(12 * 60 * 60 * 1000);
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
  });

  controller.start();
  assert.deepEqual(runs, [30]);
  retentionDays = 45;
  changeHandler?.(['sessionRetentionDays']);
  vi.advanceTimersByTime(300);
  retentionDays = 60;
  changeHandler?.(['sessionRetentionDays']);
  vi.advanceTimersByTime(300);
  assert.deepEqual(runs, [30]);

  release();
  await settle();
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
  });

  controller.start();
  await settle();
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

test('retention controller start returns while the first sweep is still running', async () => {
  let finished = false;
  let release!: () => void;
  const controller = createSessionRetentionController({
    getRetentionDays: () => 30,
    onSettingsChange: () => () => {},
    runSweep: async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      finished = true;
    },
  });

  assert.equal(controller.start(), undefined);
  assert.equal(finished, false);
  release();
  await settle();
  assert.equal(finished, true);
  await controller.stop();
});

test('retention controller stop aborts the running sweep and waits only for it to return', async () => {
  const signals: AbortSignal[] = [];
  let batches = 0;
  let returned = false;
  const controller = createSessionRetentionController({
    getRetentionDays: () => 30,
    onSettingsChange: () => () => {},
    // Never finishes on its own; checks the signal between batches like the real sweep.
    runSweep: async (_days, signal) => {
      signals.push(signal);
      while (!signal.aborted) {
        batches += 1;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      returned = true;
    },
  });

  controller.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, false);
  const batchesBeforeStop = batches;

  await controller.stop();
  assert.equal(signals[0].aborted, true);
  assert.equal(returned, true);
  assert.ok(batches - batchesBeforeStop <= 1, 'stop waits for the current batch only');
});
