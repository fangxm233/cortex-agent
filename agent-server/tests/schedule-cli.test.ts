// input:  Node test runner + scheduler + schedule-cli + profile
// output: schedule mutation APIs + CLI regression tests
// pos:    Verify schedule API + CLI behavior and profile persistence
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Scheduler } from '../src/domain/scheduling/scheduler.js';
import { runScheduleCli } from '../src/domain/scheduling/schedule-cli.js';
import { getDefaultProfileName } from '../src/domain/agents/profile-manager.js';
import { SCHEDULES_FILE } from '../src/store/schedule-repo.js';

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
beforeAll(() => { productionTaskIdSnapshot = snapshotProductionTaskIds(); });
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-cli-test-'));
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

    const scheduler = new Scheduler(async () => {}, null, {}, { schedulesFile, watchFile: false });
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

  const nullProfileTask = await scheduler.add('interval', {
    intervalMs: 60000,
    message: 'null profile task',
    projectId: 'project-three',
    profile: null,
  });
  const omittedProfileTask = await scheduler.add('interval', {
    intervalMs: 60000,
    message: 'omitted profile task',
    projectId: 'project-four',
  });

  assert.equal(nullProfileTask.profile, defaultProfile);
  assert.equal(omittedProfileTask.profile, defaultProfile);
  assert.equal((await scheduler.get(nullProfileTask.id))!.profile, defaultProfile);
  assert.equal((await scheduler.get(omittedProfileTask.id))!.profile, defaultProfile);
}));

test('scheduler add preserves explicit profile', withTempSchedules(async ({ scheduler }) => {
  const task = await scheduler.add('interval', {
    intervalMs: 60000,
    message: 'explicit profile task',
    projectId: 'project-three',
    profile: 'qa',
  });

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

test('scheduler get returns a task by id and null for missing ids', withTempSchedules(async ({ scheduler }) => {
  assert.equal((await scheduler.get('int1')).message, 'interval task');
  assert.equal(await scheduler.get('missing'), null);
}));

test('scheduler setInterval updates interval tasks and refreshes nextRun', withTempSchedules(async ({ scheduler }) => {
  // ScheduleRepo.findTask returns a live reference into the JsonRepository cache;
  // updateTask then mutates that same object in-place, so capture primitives up front.
  const before = await scheduler.get('int1');
  const beforeNextRun = before.nextRun;
  const updated = await scheduler.setInterval('int1', 7200000);

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

test('scheduler pause accepts explicit pausedBy parameter', withTempSchedules(async ({ scheduler }) => {
  const paused = await scheduler.pause('int1', 'rate-limit');
  assert.equal(paused.isPaused, true);
  assert.equal(paused.pausedBy, 'rate-limit');

  const resumed = await scheduler.resume('int1');
  assert.equal(resumed.pausedBy, null);
}));

test('scheduler pause rejects once tasks', withTempSchedules(async ({ scheduler }) => {
  await scheduler.add('once', { delay: 60000, message: 'one shot', projectId: 'project-three', profile: null });
  const onceTask = (await scheduler.list()).find(task => task.type === 'once');

  await assert.rejects(scheduler.pause(onceTask.id), /cannot pause once schedule/i);
}));

test('scheduler update rejects invalid fields for the task type', withTempSchedules(async ({ scheduler }) => {
  await assert.rejects(scheduler.update('daily1', { intervalMs: 5000 }), /invalid fields/i);
}));

test('schedule CLI get prints the selected task as JSON', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['get', 'int1'], { scheduler, now: 1000 });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.id, 'int1');
  assert.equal(parsed.intervalMs, 3600000);
}));

test('schedule CLI set interval updates the task interval', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['set', 'interval', 'int1', '2h'], { scheduler, now: 1000 });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.task.id, 'int1');
  assert.equal(parsed.task.intervalMs, 7200000);
  assert.equal((await scheduler.get('int1')).intervalMs, 7200000);
}));

test('schedule CLI pause pauses a recurring task', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['pause', 'int1'], { scheduler, now: 1000 });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.task.id, 'int1');
  assert.equal(parsed.task.isPaused, true);
  assert.equal(parsed.task.nextRun, null);
  assert.equal((await scheduler.get('int1')).isPaused, true);
}));

test('schedule CLI resume resumes a paused recurring task', withTempSchedules(async ({ scheduler }) => {
  await scheduler.pause('int1');

  const result = await runScheduleCli(['resume', 'int1'], { scheduler, now: 1000 });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.task.id, 'int1');
  assert.equal(parsed.task.isPaused, false);
  assert.ok(parsed.task.nextRun >= Date.now());
  assert.equal((await scheduler.get('int1')).isPaused, false);
}));

test('schedule CLI update changes common fields and daily time', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['update', 'daily1', '--time', '10:30', '--message', 'updated daily'], { scheduler, now: 1000 });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.task.time, '10:30');
  assert.equal(parsed.task.message, 'updated daily');
  assert.equal((await scheduler.get('daily1')).time, '10:30');
}));

test('schedule CLI edit is an alias for update', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['edit', 'daily1', '--time', '11:00', '--message', 'edited daily'], { scheduler, now: 1000 });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.task.time, '11:00');
  assert.equal(parsed.task.message, 'edited daily');
  assert.equal((await scheduler.get('daily1')).time, '11:00');
}));

test('schedule CLI accepts intervalMs as a compatibility alias for interval', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['edit', 'int1', '--intervalMs', '7200000'], { scheduler, now: 1000 });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.task.intervalMs, 7200000);
  assert.equal((await scheduler.get('int1')).intervalMs, 7200000);
}));

test('schedule CLI remove deletes the target task', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['remove', 'int1'], { scheduler, now: 1000 });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.removed, true);
  assert.equal(await scheduler.get('int1'), null);
}));

// --- help tests ---

test('schedule CLI --help returns help text', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['--help'], { scheduler });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /Commands:/);
  assert.match(result.stdout, /list/);
  assert.match(result.stdout, /Examples:/);
}));

// --- error message tests ---

test('schedule CLI unknown command lists available commands', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['nonexistent'], { scheduler });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown command: 'nonexistent'/);
  assert.match(result.stderr, /Available commands:/);
}));

test('schedule CLI unknown add type lists valid types', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', 'badtype'], { scheduler });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unknown add type: 'badtype'/);
  assert.match(result.stderr, /Valid types:/);
}));

// --- ISS-CS-005 source-level guard: CLI must refuse to persist null/empty messages ---

test('schedule CLI add --type interval rejects empty --message', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', '--type', 'interval', '--interval', '30m', '--message', ''], { scheduler });
  assert.equal(result.exitCode, 1);
  // Note: --message '' is caught by the early "--message is required" check
  assert.match(result.stderr, /--message is required|null\/empty\/whitespace message/);
}));

test('schedule CLI add --type interval rejects whitespace-only --message', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', '--type', 'interval', '--interval', '30m', '--message', '   '], { scheduler });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /null\/empty\/whitespace message/);
}));

test('schedule CLI add --type interval rejects literal "null" --message', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', '--type', 'interval', '--interval', '30m', '--message', 'null'], { scheduler });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /null\/empty\/whitespace message/);
}));

test('schedule CLI add (legacy positional) rejects whitespace-only message', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', 'interval', '30m', '   '], { scheduler });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /null\/empty\/whitespace message/);
}));

test('schedule CLI add (legacy positional) rejects empty message (trailing args elide to empty)', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', 'interval', '30m'], { scheduler });
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /null\/empty\/whitespace message/);
}));

test('schedule CLI add does not persist invalid schedule — list remains unchanged', withTempSchedules(async ({ scheduler }) => {
  const before = await scheduler.list();
  const r = await runScheduleCli(['add', '--type', 'interval', '--interval', '30m', '--message', '   '], { scheduler });
  assert.equal(r.exitCode, 1);
  const after = await scheduler.list();
  assert.equal(after.length, before.length, 'rejected schedule must not be persisted');
}));

// --- flag-mode add tests ---

test('schedule CLI add with flags creates interval schedule and persists default profile when omitted', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', '--type', 'interval', '--interval', '30m', '--message', 'test flag add'], { scheduler });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.task);
  assert.equal(parsed.task.type, 'interval');
  assert.equal(parsed.task.intervalMs, 1800000);
  assert.equal(parsed.task.message, 'test flag add');
  assert.equal(parsed.task.profile, getDefaultProfileName());
}));

test('schedule CLI add legacy positional mode persists default profile when omitted', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', 'interval', '30m', 'test positional add'], { scheduler });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.task);
  assert.equal(parsed.task.type, 'interval');
  assert.equal(parsed.task.message, 'test positional add');
  assert.equal(parsed.task.profile, getDefaultProfileName());
}));

test('schedule CLI add preserves explicit profile override', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['add', '--type', 'interval', '--interval', '30m', '--message', 'test explicit profile', '--profile', 'qa'], { scheduler });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.task.profile, 'qa');
}));

// --- dry-run tests ---

test('schedule CLI remove --dry-run previews without deleting', withTempSchedules(async ({ scheduler }) => {
  const result = await runScheduleCli(['remove', 'int1', '--dry-run'], { scheduler });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.dry_run, true);
  assert.ok(parsed.would_remove);
  assert.equal(parsed.would_remove.id, 'int1');
  // Task should still exist
  assert.ok(await scheduler.get('int1'));
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
  const scheduler = new Scheduler(async () => {}, null, {}, { schedulesFile, watchFile: false });
  try {
    await scheduler.start();
    assert.equal(scheduler.timers.size, 2);
    assert.ok(scheduler.timers.has('remove-me'));

    // External writer (e.g. schedule-cli remove) modifies the file directly, bypassing the repo.
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
  const scheduler = new Scheduler(async () => {}, null, {}, { schedulesFile, watchFile: false });
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
