import { test } from 'vitest';
import assert from 'node:assert/strict';
import { handleSchedulesList } from '../../../src/domain/ui-service/query/schedules.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeUiDeps } from './ui-deps-fixture.js';

const mockSchedules = [
  { id: 'sch1', type: 'interval' as const, message: 'Check health', projectId: 'proj1', profile: 'claude-haiku', intervalMs: 1_800_000, nextRun: Date.now() + 60000, lastRun: Date.now() - 300000, isPaused: false, target: { kind: 'fresh' as const }, fallback: 'skip' as const },
  { id: 'sch2', type: 'daily' as const, message: 'Daily report', projectId: 'proj1', profile: 'claude-sonnet', time: '09:00', nextRun: Date.now() + 3600000, lastRun: Date.now() - 86400000, isPaused: false },
  // sch3 has no profile (legacy record) → must map to null, not a fabricated default.
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

test('schedules.list carries the real profile from the schedule config source', async () => {
  const result = await handleSchedulesList(makeDeps(), { projectId: 'proj1' });
  const byId = Object.fromEntries(result.map((s) => [s.id, s]));
  assert.equal(byId['sch1'].profile, 'claude-haiku');
  assert.equal(byId['sch2'].profile, 'claude-sonnet');
});

test('schedules.list carries the timing spec + target/fallback for cadence labels and edit prefill', async () => {
  const result = await handleSchedulesList(makeDeps(), {});
  const byId = Object.fromEntries(result.map((s) => [s.id, s]));
  // interval schedule: intervalMs present, time/dayOfWeek absent → null
  assert.equal(byId['sch1'].intervalMs, 1_800_000);
  assert.equal(byId['sch1'].time, null);
  assert.equal(byId['sch1'].dayOfWeek, null);
  assert.deepEqual(byId['sch1'].target, { kind: 'fresh' });
  assert.equal(byId['sch1'].fallback, 'skip');
  // daily schedule: time present
  assert.equal(byId['sch2'].time, '09:00');
  assert.equal(byId['sch2'].intervalMs, null);
  assert.equal(byId['sch2'].target, null, 'no persisted target → null, never fabricated');
  assert.equal(byId['sch2'].fallback, null);
  // weekly schedule: time + dayOfWeek present
  assert.equal(byId['sch3'].time, '10:00');
  assert.equal(byId['sch3'].dayOfWeek, 1);
});
