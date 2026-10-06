import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  handlePauseSchedule,
  handleRemoveSchedule,
  handleAddSchedule,
  handleUpdateSchedule,
} from '../../../src/domain/ui-service/mutate/schedules.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import { makeUiDeps, type UiDepsOverrides } from './ui-deps-fixture.js';
import type { ScheduleTask } from '../../../src/store/schedule-repo.js';
import type { ScheduleSpec, SchedulePatch } from '../../../src/domain/scheduling/schedule-spec.js';

function makeDeps(overrides: UiDepsOverrides = {}): UiServiceDeps {
  return makeUiDeps(overrides);
}

test('schedules.pause returns not-found on missing schedule', async () => {
  const result = await handlePauseSchedule(makeDeps(), { scheduleId: 'sch_missing' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-found');
});

test('schedules.remove returns not-found on missing schedule', async () => {
  const result = await handleRemoveSchedule(makeDeps(), { scheduleId: 'sch_missing' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-found');
});

// ── schedules.add ──────────────────────────────────────────────────

interface AddSpy {
  calls: ScheduleSpec[];
  add: UiServiceDeps['scheduler']['add'];
}

/** A spyable scheduler.add that records the spec and echoes a ScheduleTask built from it (no fs). */
function makeAddSpy(): AddSpy {
  const calls: ScheduleSpec[] = [];
  const add: UiServiceDeps['scheduler']['add'] = async (spec) => {
    calls.push(spec);
    return {
      ...spec,
      id: 'sch_created',
      createdAt: 1_700_000_000_000,
      nextRun: 1_700_000_060_000,
      lastRun: null,
    } as unknown as ScheduleTask;
  };
  return { calls, add };
}

test('schedules.add interval creates a schedule and returns ScheduleInfo', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'interval', message: 'ping', intervalMs: 60_000, projectId: 'general' });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.type, 'interval');
    assert.equal(result.data.id, 'sch_created');
    assert.equal(result.data.message, 'ping');
    assert.equal(result.data.projectId, 'general');
    assert.equal(typeof result.data.nextRun, 'string');
  }
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].type, 'interval');
  assert.deepEqual(spy.calls[0], { type: 'interval', intervalMs: 60_000, message: 'ping', projectId: 'general', profile: null });
});

test('schedules.add rejects a whitespace message and an out-of-range time without writing', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  for (const args of [{ type: 'interval', message: '   ', intervalMs: 60_000 }, { type: 'daily', message: 'm', time: '25:00' }] as const) {
    const result = await handleAddSchedule(deps, args);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'invalid-args');
  }
  assert.equal(spy.calls.length, 0);
});

test('schedules.add rejects interval without intervalMs and does not write', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'interval', message: 'm' } as any);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'invalid-args');
  assert.equal(spy.calls.length, 0);
});

test('schedules.add rejects weekly without dayOfWeek and does not write', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'weekly', message: 'm', time: '09:00' } as any);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'invalid-args');
  assert.equal(spy.calls.length, 0);
});

// ── schedules.update ───────────────────────────────────────────────

interface UpdateSpy {
  calls: Array<{ id: string; patch: SchedulePatch }>;
  scheduler: UiServiceDeps['scheduler'];
}

/** A scheduler stub whose get() returns `task` and whose update() records the patch and echoes
 *  the merged task (mirrors the real scheduler.update: Object.assign + retiming — no real fs). */
function makeUpdateSpy(task: ScheduleTask | null): UpdateSpy {
  const calls: UpdateSpy['calls'] = [];
  const scheduler: UiServiceDeps['scheduler'] = {
    list: async () => [], get: async () => task, pause: async () => null, resume: async () => null,
    remove: async () => false, add: async () => ({ id: 'sch_new' } as ScheduleTask),
    update: async (id, patch) => {
      calls.push({ id, patch });
      return task ? ({ ...task, ...patch } as ScheduleTask) : null;
    },
  };
  return { calls, scheduler };
}

const dailyTask = {
  id: 'sch_d', type: 'daily' as const, message: 'digest', projectId: 'proj1', profile: 'claude-haiku',
  time: '09:00', createdAt: 1_700_000_000_000, nextRun: 1_700_000_060_000, lastRun: null,
} as ScheduleTask;

test('schedules.update returns not-found for a missing schedule and does not write', async () => {
  const spy = makeUpdateSpy(null);
  const result = await handleUpdateSchedule(makeDeps({ scheduler: spy.scheduler }), { scheduleId: 'sch_missing', message: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-found');
  assert.equal(spy.calls.length, 0);
});

test('schedules.update rejects a timing field foreign to the schedule type before writing', async () => {
  const spy = makeUpdateSpy(dailyTask);
  const result = await handleUpdateSchedule(makeDeps({ scheduler: spy.scheduler }), { scheduleId: 'sch_d', intervalMs: 60_000 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'invalid-args');
  assert.equal(spy.calls.length, 0);
});

test('schedules.update rejects an empty patch', async () => {
  const spy = makeUpdateSpy(dailyTask);
  const result = await handleUpdateSchedule(makeDeps({ scheduler: spy.scheduler }), { scheduleId: 'sch_d' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'invalid-args');
  assert.equal(spy.calls.length, 0);
});

test('schedules.update forwards only the defined fields and returns the updated ScheduleInfo', async () => {
  const spy = makeUpdateSpy(dailyTask);
  const result = await handleUpdateSchedule(makeDeps({ scheduler: spy.scheduler }), {
    scheduleId: 'sch_d', message: 'evening digest', time: '19:30',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.data.id, 'sch_d');
    assert.equal(result.data.message, 'evening digest');
    assert.equal(result.data.time, '19:30');
    assert.equal(result.data.profile, 'claude-haiku');
  }
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0].id, 'sch_d');
  assert.deepEqual(spy.calls[0].patch, { message: 'evening digest', time: '19:30' });
});
