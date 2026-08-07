// input:  legacy schedule records, settings snapshots, fake repository
// output: upgrade mapping, conflicts, ordering, and idempotence tests
// pos:    Verifies programmatic schedules migrate into runtime settings
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { migrateBuiltinJobSchedules } from '../src/domain/scheduling/builtin-job-migration.js';

function legacyTask(dispatchType: string, patch: Record<string, unknown> = {}) {
  return {
    id: `${dispatchType}-${Math.random()}`,
    type: 'interval',
    intervalMs: 30_000,
    dispatchType,
    message: dispatchType,
    projectId: 'general',
    profile: null,
    createdAt: 1,
    ...patch,
  };
}

function harness(tasks: any[], overrides: Record<string, unknown> = {}) {
  let data = { tasks: [...tasks] };
  const values: Record<string, unknown> = {
    taskDispatchEnabled: true,
    taskDispatchIntervalMs: 30_000,
    taskArchiveEnabled: true,
    taskArchiveIntervalMs: 21_600_000,
    memoryIndexRegenEnabled: true,
    memoryIndexRegenIntervalMs: 86_400_000,
    ...overrides,
  };
  const sources: Record<string, 'default' | 'file'> = Object.fromEntries(
    Object.keys(values).map((key) => [key, Object.hasOwn(overrides, key) ? 'file' : 'default']),
  );
  const assertSettingsFileValid = vi.fn();
  const updateSettings = vi.fn(async (partial: Record<string, unknown>) => {
    Object.assign(values, partial);
    for (const key of Object.keys(partial)) sources[key] = 'file';
  });
  const repo = {
    read: vi.fn(async () => data),
    mutate: vi.fn(async (fn: (current: typeof data) => { next: typeof data; result: unknown }) => {
      const result = fn(data);
      data = result.next;
      return result.result;
    }),
  };
  return {
    repo,
    assertSettingsFileValid,
    updateSettings,
    getSettingsSnapshot: () => Object.keys(values).map((key) => ({ key, value: values[key], source: sources[key] })),
    tasks: () => data.tasks,
  };
}

test('migration preserves intervals and maps pause provenance before removing legacy records', async () => {
  const kept = legacyTask('auth-expiry-scan');
  const h = harness([
    legacyTask('task-dispatch', { intervalMs: 45_000 }),
    legacyTask('task-archive', { intervalMs: 7_200_000, isPaused: true, pausedBy: 'user' }),
    legacyTask('memory-index-regen', { intervalMs: 43_200_000, isPaused: true, pausedBy: 'rate-limit' }),
    kept,
  ]);

  const result = await migrateBuiltinJobSchedules(h);

  assert.deepEqual(h.updateSettings.mock.calls[0][0], {
    taskDispatchEnabled: true,
    taskDispatchIntervalMs: 45_000,
    taskArchiveEnabled: false,
    taskArchiveIntervalMs: 7_200_000,
    memoryIndexRegenEnabled: true,
    memoryIndexRegenIntervalMs: 43_200_000,
  });
  assert.equal(result.removed, 3);
  assert.deepEqual(h.tasks().map((task) => task.dispatchType), ['auth-expiry-scan']);
});

test('explicit settings win and identical duplicate records collapse idempotently', async () => {
  const duplicate = legacyTask('task-archive', { intervalMs: 7_200_000, isPaused: true, pausedBy: 'user' });
  const h = harness([
    duplicate,
    { ...duplicate, id: 'duplicate-2' },
  ], {
    taskArchiveEnabled: true,
    taskArchiveIntervalMs: 3_600_000,
  });

  const first = await migrateBuiltinJobSchedules(h);
  const second = await migrateBuiltinJobSchedules(h);

  assert.equal(h.updateSettings.mock.calls.length, 0);
  assert.equal(first.removed, 2);
  assert.equal(second.removed, 0);
  assert.deepEqual(h.tasks(), []);
});

test('conflicting duplicate values abort before either file is changed', async () => {
  const h = harness([
    legacyTask('task-archive', { intervalMs: 3_600_000 }),
    legacyTask('task-archive', { intervalMs: 7_200_000 }),
  ]);

  await assert.rejects(() => migrateBuiltinJobSchedules(h), /conflicting task-archive interval/i);
  assert.equal(h.updateSettings.mock.calls.length, 0);
  assert.equal(h.repo.mutate.mock.calls.length, 0);
  assert.equal(h.tasks().length, 2);
});

test('settings persist before schedule removal and a removal failure is retry-safe', async () => {
  const h = harness([legacyTask('task-dispatch', { intervalMs: 60_000 })]);
  h.repo.mutate.mockRejectedValueOnce(new Error('schedule write failed'));

  await assert.rejects(() => migrateBuiltinJobSchedules(h), /schedule write failed/);
  assert.equal(h.updateSettings.mock.calls.length, 1, 'settings are persisted first');
  assert.equal(h.tasks().length, 1, 'failed schedule write retains the legacy record');

  const retry = await migrateBuiltinJobSchedules(h);
  assert.equal(h.updateSettings.mock.calls.length, 1, 'retry sees file provenance and does not rewrite settings');
  assert.equal(retry.removed, 1);
  assert.deepEqual(h.tasks(), []);
});

test('invalid settings storage aborts before migration can overwrite it', async () => {
  const h = harness([legacyTask('task-dispatch')]);
  h.assertSettingsFileValid.mockImplementationOnce(() => { throw new Error('invalid settings file'); });

  await assert.rejects(() => migrateBuiltinJobSchedules(h), /invalid settings file/);
  assert.equal(h.updateSettings.mock.calls.length, 0);
  assert.equal(h.repo.mutate.mock.calls.length, 0);
  assert.equal(h.tasks().length, 1);
});

test('settings write failure leaves schedules untouched', async () => {
  const h = harness([legacyTask('memory-index-regen')]);
  h.updateSettings.mockRejectedValueOnce(new Error('settings write failed'));

  await assert.rejects(() => migrateBuiltinJobSchedules(h), /settings write failed/);
  assert.equal(h.repo.mutate.mock.calls.length, 0);
  assert.equal(h.tasks().length, 1);
});
