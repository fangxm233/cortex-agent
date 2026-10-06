import { test, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import assert from 'node:assert/strict';

const hookBus = vi.hoisted(() => ({
  emitCortexEvent: vi.fn(),
}));

vi.mock('@core/hook-bus.js', () => ({
  emitCortexEvent: hookBus.emitCortexEvent,
}));
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Scheduler } from '../../../src/domain/scheduling/scheduler.js';
import { normalizeScheduleSpec } from '../../../src/domain/scheduling/schedule-spec.js';
import { getDefaultProfileName } from '../../../src/domain/agents/profile-manager.js';
import { SCHEDULES_FILE } from '../../../src/store/schedule-repo.js';
import { seedTestProfiles } from '../../_seed-profiles.js';

// Tripwire: if any test accidentally binds Scheduler/ScheduleRepo to the production
// schedules.json (rather than a tempdir), the stale entries leak and the daemon
// fires them forever (see ISS-CS-005). Snapshot the live task-ID set at suite start
// and assert it's unchanged at suite end; lastRun/nextRun rewrites by the daemon are
// ignored because task IDs don't change.
function snapshotProductionTaskIds(): string {
  try {
    const data = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    return (data.tasks ?? []).map((t: { id: string }) => t.id).sort().join(',');
  } catch {
    return '';
  }
}

let productionTaskIdSnapshot = '';
beforeAll(() => {
  productionTaskIdSnapshot = snapshotProductionTaskIds();
  seedTestProfiles();
});
beforeEach(() => {
  hookBus.emitCortexEvent.mockReset();
  hookBus.emitCortexEvent.mockResolvedValue([]);
});
afterAll(() => {
  const current = snapshotProductionTaskIds();
  if (current !== productionTaskIdSnapshot) {
    throw new Error(
      `TEST POLLUTION: production ${SCHEDULES_FILE} task IDs changed during the test run. ` +
      `before=[${productionTaskIdSnapshot}] after=[${current}]. ` +
      `Some test constructed Scheduler/ScheduleRepo without a tempdir schedulesFile.`,
    );
  }
});

function withTempSchedules(testFn) {
  return async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-test-'));
    const schedulesFile = path.join(tempDir, 'schedules.json');
    fs.writeFileSync(schedulesFile, JSON.stringify({
      tasks: [
        {
          id: 'int1',
          type: 'interval',
          intervalMs: 3600000,
          message: 'interval task',
          projectId: 'project-one',
          profile: null,
          lastRun: 100,
          nextRun: 200,
          createdAt: 50,
        },
        {
          id: 'daily1',
          type: 'daily',
          time: '09:00',
          message: 'daily task',
          projectId: 'project-two',
          profile: null,
          lastRun: 100,
          nextRun: 300,
          createdAt: 60,
        },
      ],
    }, null, 2));

    const scheduler = new Scheduler(async () => {}, {}, { schedulesFile, watchFile: false });
    try {
      await testFn({ tempDir, schedulesFile, scheduler });
    } finally {
      scheduler.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test('scheduler add persists default profile when profile is null or omitted', withTempSchedules(async ({ scheduler }) => {
  const defaultProfile = getDefaultProfileName();

  const nullProfileTask = await scheduler.add(normalizeScheduleSpec({
    type: 'interval', interval: 60000, message: 'null profile task', projectId: 'project-three', profile: null,
  }));
  const omittedProfileTask = await scheduler.add(normalizeScheduleSpec({
    type: 'interval', interval: 60000, message: 'omitted profile task', projectId: 'project-four',
  }));

  assert.equal(nullProfileTask.profile, defaultProfile);
  assert.equal(omittedProfileTask.profile, defaultProfile);
  assert.equal((await scheduler.get(nullProfileTask.id))!.profile, defaultProfile);
  assert.equal((await scheduler.get(omittedProfileTask.id))!.profile, defaultProfile);
}));

test('scheduler add preserves explicit profile', withTempSchedules(async ({ scheduler }) => {
  const task = await scheduler.add(normalizeScheduleSpec({
    type: 'interval', interval: 60000, message: 'explicit profile task', projectId: 'project-three', profile: 'qa',
  }));

  assert.equal(task.profile, 'qa');
  assert.equal((await scheduler.get(task.id))!.profile, 'qa');
}));

test('scheduler run resolves legacy null profile tasks to default profile', withTempSchedules(async ({ scheduler }) => {
  const calls = [];
  scheduler.runner = async (payload) => { calls.push(payload); };

  await scheduler._runTask({
    id: 'legacy1',
    type: 'interval',
    intervalMs: 60000,
    message: 'legacy null profile',
    projectId: 'legacy-one',
    profile: null,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].profileName, getDefaultProfileName());
}));

test('scheduler skips an unregistered dispatch type instead of falling through to the LLM runner', withTempSchedules(async ({ scheduler }) => {
  const calls = [];
  scheduler.runner = async (payload) => { calls.push(payload); };

  await scheduler._runTask({
    id: 'retired-job',
    type: 'interval',
    intervalMs: 60_000,
    message: 'retired programmatic job',
    dispatchType: 'task-archive',
    projectId: 'general',
    profile: 'plan',
    createdAt: 1,
  });

  assert.equal(calls.length, 0);
}));

test('schedule updates reject built-in job dispatch types', withTempSchedules(async ({ scheduler }) => {
  await assert.rejects(
    () => scheduler.update('int1', { dispatchType: 'memory-index-regen' }),
    /built-in job.*memory-index-regen/i,
  );
  assert.equal((await scheduler.get('int1')).dispatchType, undefined);
}));

test('scheduler run emits cortex:schedule.fired with matcher payload keys', withTempSchedules(async ({ scheduler }) => {
  const calls = [];
  scheduler.runner = async (payload) => { calls.push(payload); };

  await scheduler._runTask({
    id: 'schedule-1',
    type: 'interval',
    intervalMs: 60000,
    message: 'refresh project index',
    projectId: 'atlas',
    profile: 'plan',
    createdAt: 1,
  });

  assert.deepEqual(hookBus.emitCortexEvent.mock.calls, [[
    'cortex:schedule.fired',
    { scheduleId: 'schedule-1', name: 'refresh project index', project: 'atlas' },
  ]]);
  assert.equal(calls.length, 1);
}));

test('scheduler run continues when the schedule hook rejects', withTempSchedules(async ({ scheduler }) => {
  const calls = [];
  scheduler.runner = async (payload) => { calls.push(payload); };
  hookBus.emitCortexEvent.mockRejectedValueOnce(new Error('hook failed'));

  await scheduler._runTask({
    id: 'schedule-2',
    type: 'once',
    message: 'send digest',
    projectId: 'orchard',
    profile: 'plan',
    runAt: Date.now(),
    createdAt: 1,
  });

  assert.equal(hookBus.emitCortexEvent.mock.calls[0]?.[0], 'cortex:schedule.fired');
  assert.equal(calls.length, 1);
}));

test('scheduler get returns a task by id and null for missing ids', withTempSchedules(async ({ scheduler }) => {
  assert.equal((await scheduler.get('int1')).message, 'interval task');
  assert.equal(await scheduler.get('missing'), null);
}));

test('scheduler update of an interval refreshes nextRun', withTempSchedules(async ({ scheduler }) => {
  // ScheduleRepo.findTask returns a live reference into the JsonRepository cache;
  // updateTask then mutates that same object in-place, so capture primitives up front.
  const before = await scheduler.get('int1');
  const beforeNextRun = before.nextRun;
  const updated = await scheduler.update('int1', { intervalMs: 7200000 });

  assert.equal(updated.intervalMs, 7200000);
  assert.ok(updated.nextRun >= Date.now());
  assert.ok(updated.nextRun > beforeNextRun, `expected ${updated.nextRun} > ${beforeNextRun}`);
  assert.equal((await scheduler.get('int1')).intervalMs, 7200000);
}));

test('scheduler pause marks a recurring task paused and resume reactivates it', withTempSchedules(async ({ scheduler }) => {
  const paused = await scheduler.pause('int1');
  assert.equal(paused.isPaused, true);
  assert.ok(paused.pausedAt >= Date.now() - 1000);
  assert.equal(paused.pausedBy, 'user');
  assert.equal(paused.nextRun, null);
  assert.equal((await scheduler.get('int1')).isPaused, true);

  const resumed = await scheduler.resume('int1');
  assert.equal(resumed.isPaused, false);
  assert.equal(resumed.pausedAt, null);
  assert.equal(resumed.pausedBy, null);
  assert.ok(resumed.nextRun >= Date.now());
  assert.equal((await scheduler.get('int1')).isPaused, false);
}));

test('scheduler pause rejects once tasks', withTempSchedules(async ({ scheduler }) => {
  await scheduler.add(normalizeScheduleSpec({ type: 'once', delay: '1m', message: 'one shot', projectId: 'project-three' }));
  const onceTask = (await scheduler.list()).find(task => task.type === 'once');

  await assert.rejects(scheduler.pause(onceTask.id), /cannot pause once schedule/i);
}));

test('scheduler update rejects invalid fields for the task type', withTempSchedules(async ({ scheduler }) => {
  await assert.rejects(scheduler.update('daily1', { intervalMs: 5000 }), /invalid fields/i);
}));

// --- Hot-reload integration: external write → _hotReload() reads fresh state ---
// Regression: ISS-CS-005. scheduler._hotReload() must call repo.invalidate() before read();
// otherwise stale cache hides external removals and the daemon re-persists deleted entries.

test('scheduler _hotReload picks up external removal from schedules.json', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-hot-reload-'));
  const schedulesFile = path.join(tempDir, 'schedules.json');
  fs.writeFileSync(schedulesFile, JSON.stringify({
    tasks: [
      { id: 'keep', type: 'interval', intervalMs: 60_000, message: 'keep', projectId: 'project-one', profile: 'plan', createdAt: 1, nextRun: Date.now() + 60_000 },
      { id: 'remove-me', type: 'interval', intervalMs: 60_000, message: 'removeme', projectId: 'project-one', profile: 'plan', createdAt: 1, nextRun: Date.now() + 60_000 },
    ],
  }, null, 2));
  const scheduler = new Scheduler(async () => {}, {}, { schedulesFile, watchFile: false });
  try {
    await scheduler.start();
    assert.equal(scheduler.timers.size, 2);
    assert.ok(scheduler.timers.has('remove-me'));

    // External writer (e.g. `cortex schedule remove`) modifies the file directly, bypassing the repo.
    fs.writeFileSync(schedulesFile, JSON.stringify({
      tasks: [
        { id: 'keep', type: 'interval', intervalMs: 60_000, message: 'keep', projectId: 'project-one', profile: 'plan', createdAt: 1, nextRun: Date.now() + 60_000 },
      ],
    }, null, 2));

    await scheduler._hotReload();

    assert.equal(scheduler.timers.size, 1, 'hot-reload must drop the removed timer');
    assert.ok(scheduler.timers.has('keep'));
    assert.ok(!scheduler.timers.has('remove-me'));

    // A subsequent mutate (e.g. lastRun update) must write only the kept task — not resurrect the removed one.
    await scheduler.update('keep', { message: 'keep-updated' });
    const persisted = JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
    const ids = persisted.tasks.map((t: { id: string }) => t.id).sort();
    assert.deepEqual(ids, ['keep'], 'removed entry must not be resurrected by stale cache');
  } finally {
    scheduler.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('scheduler _hotReload picks up external additions from schedules.json', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-hot-reload-'));
  const schedulesFile = path.join(tempDir, 'schedules.json');
  fs.writeFileSync(schedulesFile, JSON.stringify({ tasks: [] }, null, 2));
  const scheduler = new Scheduler(async () => {}, {}, { schedulesFile, watchFile: false });
  try {
    await scheduler.start();
    assert.equal(scheduler.timers.size, 0);

    fs.writeFileSync(schedulesFile, JSON.stringify({
      tasks: [
        { id: 'new', type: 'interval', intervalMs: 60_000, message: 'new', projectId: 'project-one', profile: 'plan', createdAt: 1, nextRun: Date.now() + 60_000 },
      ],
    }, null, 2));

    await scheduler._hotReload();

    assert.equal(scheduler.timers.size, 1);
    assert.ok(scheduler.timers.has('new'));
  } finally {
    scheduler.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
