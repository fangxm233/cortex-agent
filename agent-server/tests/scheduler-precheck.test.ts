// input:  Node test runner + Scheduler module
// output: preCheck exit-code + env-var passing tests
// pos:    Verify preCheck skip/execute and env passing
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { test, beforeAll, afterAll } from 'vitest';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Scheduler } from '../src/domain/scheduling/scheduler.js';
import { SCHEDULES_FILE } from '../src/store/schedule-repo.js';

// Tripwire against ISS-CS-005-class pollution. See schedule-cli.test.ts for rationale.
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

// The scheduler fires real timers and runs preCheck via a real (synchronous) child
// process, so fake timers cannot fast-forward these tests. Instead of fixed sleeps
// (which flake under load and waste wall time), poll for the observable condition.
// Returns quietly on timeout — the caller's assertions then fail with their own messages.
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10));
  }
}

// Read one task back from the schedules file (null while a write is in flight).
function readTask(schedulesFile: string, id: string): any | null {
  try {
    const data = JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
    return (data.tasks ?? []).find((t: any) => t.id === id) ?? null;
  } catch {
    return null;
  }
}

function withPreCheckSchedules(testFn) {
  return async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'precheck-test-'));
    const schedulesFile = path.join(tempDir, 'schedules.json');
    const runnerCalls: any[] = [];
    const runner = async (args: any) => { runnerCalls.push(args); };

    try {
      await testFn({ tempDir, schedulesFile, runnerCalls, runner });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

test('preCheck exit 0 allows task to run', withPreCheckSchedules(async ({ schedulesFile, runnerCalls, runner }) => {
  fs.writeFileSync(schedulesFile, JSON.stringify({
    tasks: [{
      id: 'pc1',
      type: 'interval',
      intervalMs: 50,
      message: 'precheck pass test',
      projectId: 'precheck-project',
      profile: null,
      preCheck: 'exit 0',
      lastRun: null,
      nextRun: Date.now() + 10,
      createdAt: Date.now(),
    }],
  }, null, 2));

  const scheduler = new Scheduler(runner, null, {}, { schedulesFile, watchFile: false });
  await scheduler.start();

  await waitFor(() => runnerCalls.length >= 1);
  // Let the fire chain finish its post-run bookkeeping (lastRun write) before
  // stop() + tempdir removal, so no write races the cleanup.
  await waitFor(() => readTask(schedulesFile, 'pc1')?.lastRun != null);
  scheduler.stop();

  assert.ok(runnerCalls.length >= 1, 'runner should have been called at least once');
}));

test('preCheck exit 1 skips task and sets lastSkipped', withPreCheckSchedules(async ({ schedulesFile, runnerCalls, runner }) => {
  const lastRunTs = Date.now() - 1000;
  fs.writeFileSync(schedulesFile, JSON.stringify({
    tasks: [{
      id: 'pc2',
      type: 'interval',
      intervalMs: 50,
      message: 'precheck skip test',
      projectId: 'precheck-project',
      profile: null,
      preCheck: 'exit 1',
      lastRun: lastRunTs,
      nextRun: Date.now() + 10,
      createdAt: Date.now(),
    }],
  }, null, 2));

  const scheduler = new Scheduler(runner, null, {}, { schedulesFile, watchFile: false });
  await scheduler.start();

  // The skip path's observable outcome is the lastSkipped write; poll for it.
  await waitFor(() => Boolean(readTask(schedulesFile, 'pc2')?.lastSkipped));
  scheduler.stop();

  assert.equal(runnerCalls.length, 0, 'runner should not have been called');

  // Verify lastRun was NOT updated (still the original value)
  const data = JSON.parse(fs.readFileSync(schedulesFile, 'utf8'));
  const task = data.tasks.find(t => t.id === 'pc2');
  assert.equal(task.lastRun, lastRunTs, 'lastRun should not be updated on skip');
  assert.ok(task.lastSkipped, 'lastSkipped should be set');
  assert.ok(task.lastSkipped >= Date.now() - 5000, 'lastSkipped should be recent');
}));

test('task without preCheck runs normally', withPreCheckSchedules(async ({ schedulesFile, runnerCalls, runner }) => {
  fs.writeFileSync(schedulesFile, JSON.stringify({
    tasks: [{
      id: 'pc3',
      type: 'interval',
      intervalMs: 50,
      message: 'no precheck test',
      projectId: 'precheck-project',
      profile: null,
      lastRun: null,
      nextRun: Date.now() + 10,
      createdAt: Date.now(),
    }],
  }, null, 2));

  const scheduler = new Scheduler(runner, null, {}, { schedulesFile, watchFile: false });
  await scheduler.start();

  await waitFor(() => runnerCalls.length >= 1);
  await waitFor(() => readTask(schedulesFile, 'pc3')?.lastRun != null);
  scheduler.stop();

  assert.ok(runnerCalls.length >= 1, 'runner should have been called');
}));

test('preCheck receives PRECHECK_LAST_RUN env var', withPreCheckSchedules(async ({ tempDir, schedulesFile, runnerCalls, runner }) => {
  const envFile = path.join(tempDir, 'env-dump.txt');
  const lastRunMs = Date.now() - 60000;

  // Use >> (append) so we can check the first invocation's value
  fs.writeFileSync(schedulesFile, JSON.stringify({
    tasks: [{
      id: 'pc4',
      type: 'interval',
      intervalMs: 50,
      message: 'env var test',
      projectId: 'precheck-project',
      profile: null,
      preCheck: `bash -c 'echo $PRECHECK_LAST_RUN >> ${envFile}; exit 0'`,
      lastRun: lastRunMs,
      nextRun: Date.now() + 10,
      createdAt: Date.now(),
    }],
  }, null, 2));

  const scheduler = new Scheduler(runner, null, {}, { schedulesFile, watchFile: false });
  await scheduler.start();

  // preCheck (writes envFile) runs before the runner, so runner-called implies
  // envFile exists; then wait for the post-run lastRun write to settle.
  await waitFor(() => runnerCalls.length >= 1);
  await waitFor(() => {
    const lastRun = readTask(schedulesFile, 'pc4')?.lastRun;
    return lastRun != null && lastRun !== lastRunMs;
  });
  scheduler.stop();

  assert.ok(runnerCalls.length >= 1, 'runner should have been called');
  const lines = fs.readFileSync(envFile, 'utf8').trim().split('\n');
  // First invocation should receive the original lastRun
  assert.equal(lines[0], String(lastRunMs), 'first PRECHECK_LAST_RUN should match initial lastRun');
}));

