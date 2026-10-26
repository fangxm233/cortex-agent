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
  getProjectDir,
  getSessionFilePath,
  restoreBackup,
} from '../src/domain/sessions/session-backup.js';
import { DATA_DIR } from '../src/core/paths.js';

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

test('a clean session\'s backups live under its workspace\'s Claude project folder', async () => {
  const sessionId = `claude-clean-${process.pid}-${Date.now()}`;
  const workspace = path.join(DATA_DIR, 'workspaces', 'a1b2c3d4');
  const sessionFile = getSessionFilePath(sessionId, workspace);
  assert.equal(path.dirname(sessionFile), getProjectDir(workspace));
  assert.notEqual(getProjectDir(workspace), getProjectDir());
  assert.ok(path.basename(path.dirname(sessionFile)).endsWith('-workspaces-a1b2c3d4'));
  mkdirSync(path.dirname(sessionFile), { recursive: true });
  writeFileSync(sessionFile, 'before\n', 'utf8');
  try {
    assert.equal(await createBackup(sessionId, 1, workspace), `${sessionFile}.turn-1.bak`);
    writeFileSync(sessionFile, 'after\n', 'utf8');
    assert.equal(await restoreBackup(sessionId, 1, workspace), true);
    assert.equal(readFileSync(sessionFile, 'utf8'), 'before\n');
    assert.equal(await restoreBackup(sessionId, 1), false, 'the default cwd holds no such transcript');
  } finally {
    rmSync(path.dirname(sessionFile), { recursive: true, force: true });
  }
});
