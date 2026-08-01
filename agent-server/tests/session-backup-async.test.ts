// input:  Claude backup helpers and controlled promise copies
// output: round-trip, event-loop, and failure regressions
// pos:    Verifies Claude transcript copies stay asynchronous
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const copyControl = vi.hoisted(() => ({
  calls: [] as Array<[string, string]>,
  handler: null as null | ((source: string, destination: string) => Promise<void>),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    copyFile: async (source: string, destination: string) => {
      copyControl.calls.push([source, destination]);
      if (copyControl.handler) return copyControl.handler(source, destination);
      await actual.copyFile(source, destination);
    },
  };
});

import {
  createBackup,
  getSessionFilePath,
  restoreBackup,
} from '../src/domain/sessions/session-backup.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  copyControl.calls.length = 0;
  copyControl.handler = null;
});

test('Claude create and restore preserve transcript bytes through the real async copy boundary', async () => {
  const sessionId = `claude-roundtrip-${process.pid}-${Date.now()}`;
  const sessionFile = getSessionFilePath(sessionId);
  const backupFile = `${sessionFile}.turn-2.bak`;
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, 'before-turn\n', 'utf8');

  try {
    assert.equal(await createBackup(sessionId, 2), backupFile);
    writeFileSync(sessionFile, 'after-turn\n', 'utf8');
    assert.equal(await restoreBackup(sessionId, 2), true);
    assert.equal(readFileSync(sessionFile, 'utf8'), 'before-turn\n');
  } finally {
    rmSync(sessionFile, { force: true });
    rmSync(backupFile, { force: true });
  }
});

test('Claude createBackup yields to the event loop while copyFile is pending', async () => {
  const sessionId = `claude-pending-${process.pid}-${Date.now()}`;
  const gate = deferred();
  copyControl.handler = async () => gate.promise;
  let settled = false;

  const operation = createBackup(sessionId, 4).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.equal(copyControl.calls.length, 1);
  gate.resolve();
  assert.equal(await operation, `${getSessionFilePath(sessionId)}.turn-4.bak`);
});

test('Claude restoreBackup yields to the event loop while copyFile is pending', async () => {
  const sessionId = `claude-restore-pending-${process.pid}-${Date.now()}`;
  const gate = deferred();
  copyControl.handler = async () => gate.promise;
  let settled = false;

  const operation = restoreBackup(sessionId, 4).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settled, false);
  assert.deepEqual(copyControl.calls, [[
    `${getSessionFilePath(sessionId)}.turn-4.bak`,
    getSessionFilePath(sessionId),
  ]]);
  gate.resolve();
  assert.equal(await operation, true);
});

test('Claude helpers preserve missing-file null and false results', async () => {
  const sessionId = `claude-missing-${process.pid}-${Date.now()}`;
  assert.equal(await createBackup(sessionId, 1), null);
  assert.equal(await restoreBackup(sessionId, 1), false);
});

test('Claude helpers convert non-ENOENT copy failures to best-effort results', async () => {
  const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  copyControl.handler = async () => { throw error; };
  const sessionId = `claude-error-${process.pid}-${Date.now()}`;

  assert.equal(await createBackup(sessionId, 1), null);
  assert.equal(await restoreBackup(sessionId, 1), false);
});
