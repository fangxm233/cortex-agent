import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { OwnedLocalLaunchGate, ownedLocalEnvironment } from '../src/domain/remote/owned-local-launch.js';

const online = vi.fn(() => false);
const recover = vi.fn(async (_device: string): Promise<boolean | undefined> => undefined);
const markLaunchAttempted = vi.fn(async (_device: string, _signal: AbortSignal) => {});
const launch = vi.fn((_device: string) => {});
let gate: OwnedLocalLaunchGate;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  online.mockReturnValue(false);
  recover.mockResolvedValue(undefined);
  gate = new OwnedLocalLaunchGate({ online, recover, markLaunchAttempted, launch });
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
  const pending = Promise.all([gate.start('local'), gate.start('local'), gate.start('local')]);
  await vi.advanceTimersByTimeAsync(35_000);
  await pending;
  expect(recover).toHaveBeenCalledTimes(1);
  expect(launch).toHaveBeenCalledTimes(1);
});
test.each([undefined, true])('launch history %s allows a 30s-backoff survivor to reconnect', async history => {
  recover.mockResolvedValue(history);
  const pending = gate.start('local');
  await vi.advanceTimersByTimeAsync(30_500);
  expect(launch).not.toHaveBeenCalled();
  online.mockReturnValue(true);
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(launch).not.toHaveBeenCalled();
});
test.each([undefined, true])('launch history %s keeps the full 35s grace when offline', async history => {
  recover.mockResolvedValue(history);
  const pending = gate.start('local');
  await vi.advanceTimersByTimeAsync(34_750);
  expect(launch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(250);
  await pending;
  expect(launch).toHaveBeenCalledOnce();
});
test('stop cancels reconnect wait and its continuation', async () => {
  const pending = gate.start('local');
  await vi.advanceTimersByTimeAsync(500);
  gate.stop();
  await pending;
  await vi.advanceTimersByTimeAsync(40_000);
  expect(launch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
test('stop while recovering prevents late spawn even after resume', async () => {
  let finish!: () => void;
  recover.mockImplementationOnce(() => new Promise<undefined>(resolve => { finish = () => resolve(undefined); }));
  const pending = gate.start('local');
  gate.stop();
  expect(recover).toHaveBeenCalledWith('local', expect.objectContaining({ aborted: true }));
  gate.resume();
  finish();
  await pending;
  expect(launch).not.toHaveBeenCalled();
  const retry = gate.start('local');
  await vi.advanceTimersByTimeAsync(35_000);
  await retry;
  expect(launch).toHaveBeenCalledOnce();
});
test('fresh intent skips grace, single-flights and awaits the durable attempt before spawning', async () => {
  recover.mockResolvedValue(false);
  let finish!: () => void;
  markLaunchAttempted.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = Promise.all([gate.start('local'), gate.start('local')]);
  await vi.advanceTimersByTimeAsync(0);
  expect(markLaunchAttempted).toHaveBeenCalledOnce();
  expect(launch).not.toHaveBeenCalled();
  finish();
  await pending;
  expect(launch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
test.each(['stop', 'online'])('%s during the durable attempt latch prevents late spawn', async action => {
  recover.mockResolvedValue(false);
  let finish!: () => void;
  markLaunchAttempted.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = gate.start('local');
  await vi.advanceTimersByTimeAsync(0);
  expect(markLaunchAttempted).toHaveBeenCalledWith('local', expect.any(AbortSignal));
  if (action === 'stop') { gate.stop(); gate.resume(); }
  else online.mockReturnValue(true);
  finish();
  await pending;
  expect(launch).not.toHaveBeenCalled();
});
test('attempt persistence failure prevents spawn', async () => {
  recover.mockResolvedValue(false);
  markLaunchAttempted.mockRejectedValueOnce(new Error('intent write failed'));
  const pending = gate.start('local');
  await Promise.all([
    expect(pending).rejects.toThrow('intent write failed'),
    vi.advanceTimersByTimeAsync(35_000),
  ]);
  expect(launch).not.toHaveBeenCalled();
});
test('recovery failure is real and a later retry can proceed', async () => {
  recover.mockRejectedValueOnce(new Error('invalid payload'));
  await expect(gate.start('local')).rejects.toThrow('invalid payload');
  expect(launch).not.toHaveBeenCalled();
  const retry = gate.start('local');
  await vi.advanceTimersByTimeAsync(35_000);
  await retry;
  expect(launch).toHaveBeenCalledOnce();
});
