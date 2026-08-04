import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  handlePauseSchedule,
  handleResumeSchedule,
  handleRemoveSchedule,
  handleAddSchedule,
  handleUpdateSchedule,
} from '../../../src/domain/ui-service/mutate/schedules.js';
import type { UiServiceDeps } from '../../../src/domain/ui-service/types.js';
import type { ScheduleTask } from '../../../src/store/schedule-repo.js';

function makeDeps(overrides: Partial<UiServiceDeps> = {}): UiServiceDeps {
  return {
    projectStore: { list: () => [], get: () => undefined, exists: () => false, getDefault: () => ({ id: 'general', name: 'general', kind: 'general' as const, contextDir: '/g' }), createProject: () => ({ ok: false, code: 'invalid-name' as const, message: 'stub' }) },
    sessionStore: { listByProject: async () => [], listByOrigin: async () => [], listResumable: async () => [], getById: async () => null },
    threadStore: { getAll: () => [], get: () => null },
    taskStore: { getAll: () => [], getById: () => null, load: () => {}, refresh: () => {} },
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as ScheduleTask) },
    executionRegistry: { getExecution: () => null, getAll: () => [], cancelExecution: () => null },
    executionLogTailer: { startTail: () => {}, stopTail: () => {}, refCount: () => 0 },
    conversationHistory: { getHistory: async () => null },
    sendSessionMessage: () => {},
    approvalsPath: '/tmp/nonexistent-approvals.md',
    runningExecutions: { getAll: () => [] } as any,
    costSummary: async () => ({ today: 0, week: 0, month: 0, total: 0, byMode: {} as any, byProject: {}, byTrigger: {}, bySource: {}, byBackend: {}, tokens: {} as any, entryCount: 0, dailyBudget: 0, forecastToday: 0, dailyCost: [], byTriggerScoped: {} }),
    bus: { subscribe: () => ({ unsubscribe: () => {} }), publish: () => {} } as any,
    createDirectSession: async () => ({ sessionId: '', sessionName: '', channel: '' }),
    cancelSessionRun: async () => 0,
    switchSessionProfile: async () => ({ ok: true, name: '', currentBackend: '', targetBackend: '', backendChanged: false }),
    clientRegistry: { getOnlineDevices: () => [], isDeviceOnline: () => false, getMachineRegistry: () => ({}) },
    adapter: {} as any,
    ...overrides,
  };
}

test('schedules.pause returns not-found on missing schedule', async () => {
  const result = await handlePauseSchedule(makeDeps(), { scheduleId: 'sch_missing' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-found');
});

test('schedules.pause returns ok on success', async () => {
  const result = await handlePauseSchedule(makeDeps({
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => ({ id: 'sch1', isPaused: true } as any), resume: async () => null, remove: async () => false, add: async () => ({ id: 'sch_new' } as ScheduleTask) },
  }), { scheduleId: 'sch1' });
  assert.equal(result.ok, true);
});

test('schedules.resume returns not-found on missing schedule', async () => {
  const result = await handleResumeSchedule(makeDeps(), { scheduleId: 'sch_missing' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-found');
});

test('schedules.resume returns ok on success', async () => {
  const result = await handleResumeSchedule(makeDeps({
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => ({ id: 'sch1', isPaused: false } as any), remove: async () => false, add: async () => ({ id: 'sch_new' } as ScheduleTask) },
  }), { scheduleId: 'sch1' });
  assert.equal(result.ok, true);
});

test('schedules.remove returns not-found on missing schedule', async () => {
  const result = await handleRemoveSchedule(makeDeps(), { scheduleId: 'sch_missing' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'not-found');
});

test('schedules.remove returns ok on success', async () => {
  const result = await handleRemoveSchedule(makeDeps({
    scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => true, add: async () => ({ id: 'sch_new' } as ScheduleTask) },
  }), { scheduleId: 'sch1' });
  assert.equal(result.ok, true);
});

// ── schedules.add ──────────────────────────────────────────────────

interface AddSpy {
  calls: Array<{ type: string; options: Record<string, any> }>;
  add: UiServiceDeps['scheduler']['add'];
}

/** A spyable scheduler.add that records calls and echoes a ScheduleTask built from the options
 *  (mirrors what the real injected add returns after buildTask + backfill — no real fs). */
function makeAddSpy(): AddSpy {
  const calls: AddSpy['calls'] = [];
  const add: UiServiceDeps['scheduler']['add'] = async (type, options) => {
    calls.push({ type, options });
    return {
      id: 'sch_created',
      type,
      message: options.message,
      projectId: options.projectId,
      profile: options.profile ?? null,
      intervalMs: options.intervalMs,
      time: options.time,
      dayOfWeek: options.dayOfWeek,
      delay: options.delay,
      createdAt: 1_700_000_000_000,
      nextRun: 1_700_000_060_000,
      lastRun: null,
      target: options.target,
      fallback: options.fallback,
    } as ScheduleTask;
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
  assert.equal(spy.calls[0].options.intervalMs, 60_000);
});

test('schedules.add returns the profile it was given in ScheduleInfo', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'interval', message: 'ping', intervalMs: 60_000, profile: 'claude-haiku' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.profile, 'claude-haiku');
  assert.equal(spy.calls[0].options.profile, 'claude-haiku');
});

test('schedules.add ScheduleInfo profile is null when omitted (honest placeholder)', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'once', message: 'm', delay: 1_000 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.profile, null);
});

test('schedules.add daily creates a schedule', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'daily', message: 'digest', time: '09:00' });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.type, 'daily');
  assert.equal(spy.calls[0].options.time, '09:00');
});

test('schedules.add weekly creates a schedule', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'weekly', message: 'review', time: '09:00', dayOfWeek: 1 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.type, 'weekly');
  assert.equal(spy.calls[0].options.dayOfWeek, 1);
  assert.equal(spy.calls[0].options.time, '09:00');
});

test('schedules.add once creates a schedule', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'once', message: 'run once', delay: 5_000 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.type, 'once');
  assert.equal(spy.calls[0].options.delay, 5_000);
});

test('schedules.add forwards target and fallback to scheduler.add', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, {
    type: 'interval', message: 'ping', intervalMs: 60_000,
    target: { kind: 'project', projectId: 'general' }, fallback: 'skip',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(spy.calls[0].options.target, { kind: 'project', projectId: 'general' });
  assert.equal(spy.calls[0].options.fallback, 'skip');
});

test('schedules.add defaults projectId to general when omitted', async () => {
  const spy = makeAddSpy();
  const deps = makeDeps({ scheduler: { update: async () => null, list: async () => [], get: async () => null, pause: async () => null, resume: async () => null, remove: async () => false, add: spy.add } });
  const result = await handleAddSchedule(deps, { type: 'once', message: 'm', delay: 1_000 });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.data.projectId, 'general');
  assert.equal(spy.calls[0].options.projectId, 'general');
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
  calls: Array<{ id: string; patch: Record<string, any> }>;
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
