import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSchedulesList } from '../../../src/domain/ui-service/query/schedules.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeUiDeps } from './ui-deps-fixture.js';

const selection = { backend: 'claude' as const, provider: null, model: 'haiku', thinking: null, mode: 'plan' };
const mockSchedules = [
  { id: 'sch1', type: 'interval' as const, message: 'Check health', projectId: 'proj1', selection, intervalMs: 1_800_000, nextRun: Date.now() + 60000, lastRun: Date.now() - 300000, isPaused: false },
  { id: 'sch2', type: 'daily' as const, message: 'Daily report', projectId: 'proj1', selection: { ...selection, model: 'sonnet' }, time: '09:00', nextRun: Date.now() + 3600000, lastRun: Date.now() - 86400000, isPaused: false },
  // A legacy record without a selection maps to null, not a fabricated default.
  { id: 'sch3', type: 'weekly' as const, message: 'Weekly review', projectId: 'proj2', dayOfWeek: 1, time: '10:00', nextRun: Date.now() + 7200000, lastRun: null, isPaused: true, pausedBy: 'user' },
];

function makeDeps(): UiServiceDeps {
  return makeUiDeps({
    scheduler: { update: async () => null, list: async () => mockSchedules as any, get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as any) },
  });
}

test('schedules.list filters by projectId', async () => {
  const result = await handleSchedulesList(makeDeps(), { projectId: 'proj1' });
  assert.equal(result.length, 2);
  assert.ok(result.every(s => s.projectId === 'proj1'));
});

test('schedules.list filters by paused', async () => {
  const result = await handleSchedulesList(makeDeps(), { paused: true });
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'sch3');
  assert.equal(result[0].paused, true);
});

test('schedules.list carries the persisted selection, null for legacy records', async () => {
  const result = await handleSchedulesList(makeDeps(), {});
  const byId = Object.fromEntries(result.map((s) => [s.id, s]));
  assert.deepEqual(byId['sch1'].selection, selection);
  assert.deepEqual(byId['sch2'].selection, { ...selection, model: 'sonnet' });
  assert.equal(byId['sch3'].selection, null);
});

test('schedules.list carries the timing spec for cadence labels and edit prefill', async () => {
  const result = await handleSchedulesList(makeDeps(), {});
  const byId = Object.fromEntries(result.map((s) => [s.id, s]));
  // interval schedule: intervalMs present, time/dayOfWeek absent → null
  assert.equal(byId['sch1'].intervalMs, 1_800_000);
  assert.equal(byId['sch1'].time, null);
  assert.equal(byId['sch1'].dayOfWeek, null);
  // daily schedule: time present
  assert.equal(byId['sch2'].time, '09:00');
  assert.equal(byId['sch2'].intervalMs, null);
  // weekly schedule: time + dayOfWeek present
  assert.equal(byId['sch3'].time, '10:00');
  assert.equal(byId['sch3'].dayOfWeek, 1);
});
