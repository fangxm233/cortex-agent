// input:  Vitest and SSH tunnel supervisor fakes
// output: SSH reverse-route lifecycle regression coverage
// pos:    Verifies tunnel argv, deduplication, retry and shutdown
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { EventEmitter } from 'node:events';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import {
  SshTunnelSupervisor,
  buildSshTunnelArgs,
  type SshTunnelSpec,
} from '../src/domain/remote/client-ssh-tunnel.js';

const SPEC: SshTunnelSpec = {
  device: 'worker-a',
  host: 'user@worker-a',
  remotePort: 13002,
  serverPort: 3002,
};

class FakeChild extends EventEmitter {
  pid = 1234;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killedWith: NodeJS.Signals[] = [];

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killedWith.push(signal);
    queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

function makeHarness() {
  const children: FakeChild[] = [];
  const execCalls: string[][] = [];
  const spawnCalls: string[][] = [];
  const execSsh = vi.fn(async (args: string[]) => {
    execCalls.push(args);
    if (args.includes('exit')) throw new Error('no stale master');
    return 'Master running';
  });
  const spawnSsh = vi.fn((args: string[]) => {
    spawnCalls.push(args);
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ChildProcess;
  });
  const supervisor = new SshTunnelSupervisor({
    execSsh,
    spawnSsh,
    controlDir: '/tmp/cortex-tunnel-test',
    retryBaseMs: 10,
    retryMaxMs: 20,
    readyTimeoutMs: 100,
    readyPollMs: 1,
    stopTimeoutMs: 20,
  });
  return { supervisor, children, execCalls, spawnCalls, execSsh, spawnSsh };
}

afterEach(() => {
  vi.useRealTimers();
});

test('buildSshTunnelArgs binds only remote loopback and keeps host as one argv', () => {
  const args = buildSshTunnelArgs(SPEC, '/tmp/control.sock');
  assert.deepEqual(args.slice(-3), [
    '-R',
    '127.0.0.1:13002:127.0.0.1:3002',
    'user@worker-a',
  ]);
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('-T'));
  assert.ok(args.includes('-M'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.ok(args.includes('ServerAliveInterval=15'));
  assert.ok(args.includes('ServerAliveCountMax=3'));
  assert.ok(args.includes('/tmp/control.sock'));
});

test('concurrent ensure calls share one SSH child and wait for control readiness', async () => {
  const h = makeHarness();
  await Promise.all([h.supervisor.ensure(SPEC), h.supervisor.ensure(SPEC)]);

  assert.equal(h.spawnCalls.length, 1);
  assert.equal(h.supervisor.state('worker-a'), 'running');
  assert.ok(h.execCalls.some((args) => args.includes('exit')));
  assert.ok(h.execCalls.some((args) => args.includes('check')));
  await h.supervisor.stopAll();
});

test('an exited tunnel retries independently without duplicate children', async () => {
  vi.useFakeTimers();
  const h = makeHarness();
  await h.supervisor.ensure(SPEC);

  h.children[0].emit('exit', 255, null);
  assert.equal(h.supervisor.state('worker-a'), 'backoff');
  await vi.advanceTimersByTimeAsync(10);
  await vi.runAllTicks();

  assert.equal(h.spawnCalls.length, 2);
  assert.equal(h.supervisor.state('worker-a'), 'running');
  await h.supervisor.stopAll();
});

test('stopAll fences exit callbacks and leaves no retry timer', async () => {
  vi.useFakeTimers();
  const h = makeHarness();
  await h.supervisor.ensure(SPEC);
  await h.supervisor.stopAll();
  await vi.advanceTimersByTimeAsync(100);

  assert.equal(h.supervisor.state('worker-a'), 'stopped');
  assert.equal(h.spawnCalls.length, 1);
  assert.deepEqual(h.children[0].killedWith, ['SIGTERM']);
});

test('child error and later exit schedule only one retry', async () => {
  vi.useFakeTimers();
  const h = makeHarness();
  await h.supervisor.ensure(SPEC);
  h.children[0].emit('error', new Error('SSH transport failed'));
  h.children[0].emit('exit', 255, null);
  await vi.advanceTimersByTimeAsync(10);
  await vi.runAllTicks();

  assert.equal(h.spawnCalls.length, 2);
  await h.supervisor.stopAll();
});
