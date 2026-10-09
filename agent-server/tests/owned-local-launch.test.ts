import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OwnedLocalLaunchGate, ownedLocalEnvironment } from '../src/domain/remote/owned-local-launch.js';

const online = vi.fn(() => false);
const recover = vi.fn(async (_device: string) => {});
const pidAlive = vi.fn(() => false);
const launch = vi.fn((_device: string) => {});
let gate: OwnedLocalLaunchGate;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  online.mockReturnValue(false);
  pidAlive.mockReturnValue(false);
  gate = new OwnedLocalLaunchGate({ online, recover, pidAlive, launch });
});
afterEach(() => { gate.stop(); vi.useRealTimers(); });

test('authoritative token/home/actual hub port override stale env, preserving native selections', () => {
  const inherited = { Path: 'private-node;private-git', PATH: 'other', npm_config_prefix: 'private-npm', CORTEX_GIT_BASH_PATH: 'private-bash', CORTEX_CLIENT_TOKEN: 'stale' };
  expect(ownedLocalEnvironment(inherited, '/custom-home', 'captured-token', 4321)).toEqual({ ...inherited,
    CORTEX_HOME: '/custom-home', CORTEX_CLIENT_TOKEN: 'captured-token', CORTEX_SERVER_URL: 'ws://127.0.0.1:4321' });
  expect(inherited.CORTEX_CLIENT_TOKEN).toBe('stale');
});
test.each([undefined, ''])('missing authoritative token %j cannot launch', token => {
  expect(() => ownedLocalEnvironment({}, '/custom-home', token, 4321)).toThrow(/token/i);
});
test('hub not listening cannot use the UI port', () => {
  expect(() => ownedLocalEnvironment({}, '/custom-home', 'token', null)).toThrow(/manager|port/i);
});
test('already hello-online skips recovery and spawn', async () => {
  online.mockReturnValue(true);
  await gate.start('local');
  expect(recover).not.toHaveBeenCalled();
  expect(launch).not.toHaveBeenCalled();
});
test('concurrent starts single-flight recovery before one launch', async () => {
  await Promise.all([gate.start('local'), gate.start('local'), gate.start('local')]);
  expect(recover).toHaveBeenCalledTimes(1);
  expect(launch).toHaveBeenCalledTimes(1);
});
test('surviving PID gets bounded reconnect opportunity; real hello avoids spawn', async () => {
  pidAlive.mockReturnValue(true);
  const pending = gate.start('local');
  await vi.advanceTimersByTimeAsync(1000);
  expect(launch).not.toHaveBeenCalled();
  online.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(launch).not.toHaveBeenCalled();
});
test('reused live PID never suppresses launch forever', async () => {
  pidAlive.mockReturnValue(true);
  const pending = gate.start('local');
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
  expect(launch).toHaveBeenCalledOnce();
});
test('stop cancels reconnect wait and its continuation', async () => {
  pidAlive.mockReturnValue(true);
  const pending = gate.start('local');
  await vi.advanceTimersByTimeAsync(500);
  gate.stop();
  await pending;
  await vi.advanceTimersByTimeAsync(10000);
  expect(launch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
test('stop while recovering prevents late spawn even after resume', async () => {
  let finish!: () => void;
  recover.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = gate.start('local');
  gate.stop();
  gate.resume();
  finish();
  await pending;
  expect(launch).not.toHaveBeenCalled();
  await gate.start('local');
  expect(launch).toHaveBeenCalledOnce();
});
test('recovery failure is real and a later retry can proceed', async () => {
  recover.mockRejectedValueOnce(new Error('invalid payload'));
  await expect(gate.start('local')).rejects.toThrow('invalid payload');
  expect(launch).not.toHaveBeenCalled();
  await gate.start('local');
  expect(launch).toHaveBeenCalledOnce();
});
