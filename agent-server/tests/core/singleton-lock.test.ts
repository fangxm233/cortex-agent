// input:  Node test runner + core/singleton-lock.ts
// output: singleton-lock pure-function regression tests
// pos:    Verify tryAcquireSingletonLock/releaseSingletonLock/isProcessAlive against a temp pidfile
// >>> If I am updated, update me and the parent folder's CORTEX.md <<<

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isProcessAlive, tryAcquireSingletonLock, releaseSingletonLock } from '../../src/core/singleton-lock.js';

// A PID that is virtually guaranteed not to exist on this machine.
const DEAD_PID = 2147483646;

function tmpPidFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-lock-'));
  return { dir, file: path.join(dir, 'test.pid') };
}

test('isProcessAlive: current process is alive, fake pid is not', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(DEAD_PID), false);
});

test('tryAcquireSingletonLock: fresh file acquires and writes own pid', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const r = tryAcquireSingletonLock(file);
  assert.deepEqual(r, { acquired: true, stale: false });
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));
});

test('tryAcquireSingletonLock: live holder pid blocks acquisition', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, String(process.pid), 'utf8');
  const r = tryAcquireSingletonLock(file);
  assert.deepEqual(r, { acquired: false, holderPid: process.pid });
  // file must be left untouched
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));
});

test('tryAcquireSingletonLock: stale (dead) pid is reclaimed', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, String(DEAD_PID), 'utf8');
  const r = tryAcquireSingletonLock(file);
  assert.deepEqual(r, { acquired: true, stale: true });
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));
});

test('tryAcquireSingletonLock: corrupt content is reclaimed', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, 'not-a-pid', 'utf8');
  const r = tryAcquireSingletonLock(file);
  assert.deepEqual(r, { acquired: true, stale: true });
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));
});

test('releaseSingletonLock: removes file when it holds our pid', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, String(process.pid), 'utf8');
  releaseSingletonLock(file);
  assert.equal(existsSync(file), false);
});

test('releaseSingletonLock: leaves file owned by another pid', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, String(DEAD_PID), 'utf8');
  releaseSingletonLock(file);
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, 'utf8').trim(), String(DEAD_PID));
});

test('releaseSingletonLock: no-op when file is missing', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  // file does not exist — must not throw
  releaseSingletonLock(file);
  assert.equal(existsSync(file), false);
});
