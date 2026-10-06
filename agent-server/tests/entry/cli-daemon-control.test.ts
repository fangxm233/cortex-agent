import { test, afterEach, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';

import { runCli } from '../../src/entry/cli.js';
import { DAEMON_PID_FILE, DAEMON_CHILD_PID_FILE, RESTART_TRIGGER_FILE } from '../../src/core/paths.js';

const sleepers: ChildProcess[] = [];

function startSleeper(): ChildProcess {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  sleepers.push(child);
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

function exited(child: ChildProcess): Promise<NodeJS.Signals | null> {
  return new Promise((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
}

beforeEach(() => {
  // The vitest setup rebinds CORTEX_HOME per file; never drive the live daemon's control files.
  assert.ok(!DAEMON_PID_FILE.startsWith(path.join(os.homedir(), '.cortex')), DAEMON_PID_FILE);
  fs.mkdirSync(path.dirname(DAEMON_PID_FILE), { recursive: true });
});

afterEach(() => {
  for (const child of sleepers.splice(0)) child.kill('SIGKILL');
  for (const file of [DAEMON_PID_FILE, DAEMON_CHILD_PID_FILE, RESTART_TRIGGER_FILE]) fs.rmSync(file, { force: true });
});

test('daemon status reports a missing pid file as not running', async () => {
  const result = await runCli(['daemon', 'status']);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'Cortex daemon is not running.\n');
});

test('daemon status removes a corrupted pid file', async () => {
  fs.writeFileSync(DAEMON_PID_FILE, 'garbage');
  const result = await runCli(['daemon', 'status']);
  assert.match(result.stdout, /removed corrupted PID file/);
  assert.equal(fs.existsSync(DAEMON_PID_FILE), false);
});

test('daemon status removes a stale pid file', async () => {
  const pid = await deadPid();
  fs.writeFileSync(DAEMON_PID_FILE, String(pid));
  const result = await runCli(['daemon', 'status']);
  assert.match(result.stdout, new RegExp(`removed stale PID file for PID ${pid}`));
  assert.equal(fs.existsSync(DAEMON_PID_FILE), false);
});

test('daemon status reports the live daemon and its app.js child', async () => {
  const daemon = startSleeper();
  fs.writeFileSync(DAEMON_PID_FILE, String(daemon.pid));
  assert.match((await runCli(['daemon', 'status'])).stdout, /Child: {3}starting\.\.\./);

  const child = startSleeper();
  fs.writeFileSync(DAEMON_CHILD_PID_FILE, String(child.pid));
  const result = await runCli(['daemon', 'status']);
  assert.match(result.stdout, new RegExp(`PID: {5}${daemon.pid}`));
  assert.match(result.stdout, new RegExp(`Child: {3}app\\.js \\(PID ${child.pid},`));

  fs.writeFileSync(DAEMON_CHILD_PID_FILE, String(await deadPid()));
  assert.match((await runCli(['daemon', 'status'])).stdout, /Child: {3}none \(stale PID/);
});

test('daemon restart touches the restart trigger only when the daemon is alive', async () => {
  const notRunning = await runCli(['daemon', 'restart']);
  assert.equal(notRunning.exitCode, 1);
  assert.equal(fs.existsSync(RESTART_TRIGGER_FILE), false);

  const daemon = startSleeper();
  fs.writeFileSync(DAEMON_PID_FILE, String(daemon.pid));
  const result = await runCli(['daemon', 'restart']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout, `Restart signal sent to daemon (PID ${daemon.pid}).\n`);
  assert.equal(fs.existsSync(RESTART_TRIGGER_FILE), true);
});

test('daemon restart --hard signals the live app.js child', async () => {
  const daemon = startSleeper();
  fs.writeFileSync(DAEMON_PID_FILE, String(daemon.pid));
  assert.match((await runCli(['daemon', 'restart', '--hard'])).stderr, /No child PID file found/);

  const child = startSleeper();
  fs.writeFileSync(DAEMON_CHILD_PID_FILE, String(child.pid));
  const signalled = exited(child);
  const result = await runCli(['daemon', 'restart', '--hard']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(await signalled, 'SIGTERM');
});
