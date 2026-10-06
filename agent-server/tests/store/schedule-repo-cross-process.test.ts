import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileLockPath } from '../../src/core/file-lock.js';
import { ScheduleRepo, type SchedulesData, type ScheduleTask } from '../../src/store/schedule-repo.js';

// Two real processes (the daemon and `cortex schedule`, say) doing read-modify-write cycles on the
// same schedules.json at once must not lose each other's updates.

const AGENT_SERVER_DIR = path.resolve(import.meta.dirname, '../..');
const OPS_PER_WRITER = 60;

const WRITER = `
const { ScheduleRepo } = await import('./src/store/schedule-repo.ts');
const repo = new ScheduleRepo(process.env.SCHED_FILE);
const tag = process.env.SCHED_TAG;
process.stdout.write('ready\\n');
await new Promise((resolve) => process.stdin.once('data', resolve));
for (let i = 0; i < Number(process.env.SCHED_OPS); i++) {
  await repo.addTask({ id: tag + '-' + i, type: 'interval', message: tag, projectId: 'p', profile: null, createdAt: Date.now(), intervalMs: 60000 });
  await repo.updateTask('shared', (task) => { task.lastRun = (task.lastRun ?? 0) + 1; });
}
process.exit(0);
`;

function sharedTask(): ScheduleTask {
  return { id: 'shared', type: 'interval', message: 'counter', projectId: 'p', profile: null, createdAt: 0, intervalMs: 60_000, lastRun: 0 };
}

function spawnWriter(file: string, tag: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', WRITER], {
    cwd: AGENT_SERVER_DIR,
    env: { ...process.env, SCHED_FILE: file, SCHED_TAG: tag, SCHED_OPS: String(OPS_PER_WRITER) },
  });
}

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('ready')) resolve(); });
    child.once('exit', (code) => reject(new Error(`writer exited early (${code})`)));
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; stderr: string }> {
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise((resolve) => child.once('exit', (code) => resolve({ code, stderr })));
}

test('two processes mutating schedules.json concurrently lose no updates', { timeout: 60_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-xproc-'));
  t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  await fs.writeFile(file, JSON.stringify({ tasks: [sharedTask()] }));

  const writers = [spawnWriter(file, 'a'), spawnWriter(file, 'b')];
  const exits = writers.map(waitForExit);
  await Promise.all(writers.map(waitForReady));
  for (const writer of writers) writer.stdin.write('go\n');
  for (const { code, stderr } of await Promise.all(exits)) assert.equal(code, 0, stderr);

  const { tasks } = JSON.parse(await fs.readFile(file, 'utf8')) as SchedulesData;
  assert.equal(tasks.length, 1 + 2 * OPS_PER_WRITER, 'every added task survives');
  assert.equal(tasks.find((task) => task.id === 'shared')?.lastRun, 2 * OPS_PER_WRITER, 'every increment survives');
});

test('a schedules.json lock left by a dead writer does not block the next write', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'schedule-stale-'));
  t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'schedules.json');
  const deadPid = spawnSync(process.execPath, ['-e', '']).pid!;
  await fs.mkdir(fileLockPath(file));
  await fs.writeFile(path.join(fileLockPath(file), 'owner.json'), JSON.stringify({ pid: deadPid, token: 'dead', acquiredAt: Date.now() }));

  const repo = new ScheduleRepo(file);
  await repo.addTask(sharedTask());

  repo.invalidate();
  assert.deepEqual((await repo.read()).tasks.map((task) => task.id), ['shared']);
  assert.equal(await fs.stat(fileLockPath(file)).then(() => true, () => false), false);
});
