import { onTestFinished, test } from 'vitest';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  tryAcquireSingletonLock, releaseSingletonLock, readPidFile, readLivePid, touchRestartTrigger,
  isPidFileOwner, processStartTime,
} from '../../src/core/singleton-lock.js';

// A PID that is virtually guaranteed not to exist on this machine.
const DEAD_PID = 2147483646;

function tmpPidFile(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cortex-lock-'));
  return { dir, file: path.join(dir, 'test.pid') };
}

/** A live process that is not this one, standing in for a lock holder or a pid's new tenant. */
function liveOtherProcess(): number {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  onTestFinished(() => { child.kill(); });
  return child.pid!;
}

/** A pid file as left behind before a crash or reboot: written well before its pid's current tenant started. */
function writeOldPidFile(file: string, pid: number): void {
  writeFileSync(file, String(pid), 'utf8');
  const crashed = new Date(Date.now() - 60_000);
  utimesSync(file, crashed, crashed);
}

test('tryAcquireSingletonLock: fresh file acquires and writes own pid', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const r = tryAcquireSingletonLock(file);
  assert.deepEqual(r, { acquired: true, stale: false });
  assert.equal(readFileSync(file, 'utf8').trim(), String(process.pid));
});

test('tryAcquireSingletonLock: creates a missing lock directory before acquisition', (t) => {
  const { dir } = tmpPidFile();
  const file = path.join(dir, 'data', 'store', 'app.pid');
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

test('tryAcquireSingletonLock: a pid-only lock written by its running owner still blocks', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const owner = liveOtherProcess();
  writeFileSync(file, String(owner), 'utf8');
  assert.deepEqual(tryAcquireSingletonLock(file), { acquired: false, holderPid: owner });
  assert.equal(readFileSync(file, 'utf8').trim(), String(owner));
});

test('tryAcquireSingletonLock: a pid reused by a process started after the lock was written is reclaimed', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  const tenant = liveOtherProcess();
  writeOldPidFile(file, tenant);
  assert.deepEqual(tryAcquireSingletonLock(file), { acquired: true, stale: true });
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

test('readPidFile: parses a positive integer pid, null for missing or corrupt files', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(readPidFile(file), null, 'missing');
  writeFileSync(file, ' 4242\n');
  assert.equal(readPidFile(file), 4242);
  for (const bad of ['', 'abc', '-3', '0', '12.5']) {
    writeFileSync(file, bad);
    assert.equal(readPidFile(file), null, `corrupt: ${JSON.stringify(bad)}`);
  }
});

test('readLivePid: only a pid whose process is alive', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  writeFileSync(file, String(process.pid));
  assert.equal(readLivePid(file), process.pid);
  writeFileSync(file, String(DEAD_PID));
  assert.equal(readLivePid(file), null);
  writeOldPidFile(file, liveOtherProcess());
  assert.equal(readLivePid(file), null, 'reused pid');
});

test('isPidFileOwner: liveness alone decides when the pid file cannot be dated', (t) => {
  const { dir, file } = tmpPidFile();
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(isPidFileOwner(file, process.pid), true);
  assert.equal(isPidFileOwner(file, DEAD_PID), false);
});

test('processStartTime: when this process started, null for a pid with no process', () => {
  const startedAt = processStartTime(process.pid);
  assert.ok(startedAt !== null);
  assert.ok(Math.abs(startedAt - (Date.now() - process.uptime() * 1000)) < 2_000, `${startedAt}`);
  assert.equal(processStartTime(DEAD_PID), null);
});

test('touchRestartTrigger: creates the trigger, then refreshes its mtime', (t) => {
  const { dir } = tmpPidFile();
  const trigger = path.join(dir, 'store', '.restart');
  t.onTestFinished(() => rmSync(dir, { recursive: true, force: true }));

  touchRestartTrigger(trigger);
  assert.equal(existsSync(trigger), true);
  const old = new Date(Date.now() - 60_000);
  utimesSync(trigger, old, old);
  touchRestartTrigger(trigger);
  assert.ok(statSync(trigger).mtimeMs > old.getTime());
});
