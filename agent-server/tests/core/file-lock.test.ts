import { test } from 'vitest';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileLockPath, FileLockTimeoutError, withFileLock } from '../../src/core/file-lock.js';

async function tempFile(t: { onTestFinished: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-lock-'));
  t.onTestFinished(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'data.json');
}

/** Plant a lock as another holder would have left it. */
async function plantLock(file: string, owner: { pid: number; acquiredAt?: number }): Promise<void> {
  await fs.mkdir(fileLockPath(file));
  const record = { token: `planted:${owner.pid}`, processStart: null, ...owner };
  await fs.writeFile(path.join(fileLockPath(file), 'owner.json'), JSON.stringify(record));
}

function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '']);
  return child.pid!;
}

async function lockExists(file: string): Promise<boolean> {
  return fs.stat(fileLockPath(file)).then(() => true, () => false);
}

test('a lock left by a dead process is reclaimed', async (t) => {
  const file = await tempFile(t);
  await plantLock(file, { pid: deadPid(), acquiredAt: Date.now() });

  assert.equal(await withFileLock(file, async () => 'ran', { timeoutMs: 2_000 }), 'ran');
  assert.equal(await lockExists(file), false, 'released after use');
});

test('a lock held by a live process past the stale age is reclaimed', async (t) => {
  const file = await tempFile(t);
  await plantLock(file, { pid: process.pid, acquiredAt: Date.now() - 60_000 });

  assert.equal(await withFileLock(file, async () => 'ran', { timeoutMs: 2_000 }), 'ran');
});

test('waiting on a live holder times out with an error naming the file and the holder', async (t) => {
  const file = await tempFile(t);
  await plantLock(file, { pid: process.pid, acquiredAt: Date.now() });
  let ran = false;

  const error = await withFileLock(file, async () => { ran = true; }, { timeoutMs: 150 }).catch((e) => e);

  assert.ok(error instanceof FileLockTimeoutError, String(error));
  assert.match(error.message, new RegExp(`waiting for the lock on ${file}`));
  assert.match(error.message, new RegExp(`held by pid ${process.pid}`));
  assert.equal(ran, false);
  assert.equal(await lockExists(file), true, 'a live holder keeps its lock');
});

test('the lock is released when the critical section throws', async (t) => {
  const file = await tempFile(t);

  await assert.rejects(withFileLock(file, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await lockExists(file), false);
  assert.equal(await withFileLock(file, async () => 'again', { timeoutMs: 500 }), 'again');
});
