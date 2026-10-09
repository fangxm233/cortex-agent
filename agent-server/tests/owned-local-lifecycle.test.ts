import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const hooks = vi.hoisted(() => ({
  spawn: vi.fn(), recover: vi.fn(async () => {}), intent: vi.fn(), online: vi.fn(() => false),
  port: vi.fn(() => 4312), lifecycle: null as null | { onStart(): void; onStop(): Promise<void> },
}));
vi.mock('child_process', async original => ({ ...await original<typeof import('child_process')>(), spawn: hooks.spawn }));
vi.mock('../src/domain/remote/client-manager.js', () => ({
  isDeviceOnline: hooks.online, getClientManagerPort: hooks.port,
  setHubLifecycleHooks: (value: typeof hooks.lifecycle) => { hooks.lifecycle = value; },
}));
vi.mock('../src/domain/remote/local-client-install.js', async original => ({
  ...await original<typeof import('../src/domain/remote/local-client-install.js')>(),
  readLocalClientIntent: hooks.intent, completeLocalClientInstall: hooks.recover,
}));
import { DATA_DIR, CONFIG_DIR, STORE_DIR } from '../src/core/paths.js';
import { captureAuthTokensForRuntime } from '../src/core/auth.js';
import { startRemoteClient, _setMachineRegistryProviderForTesting, _getRestartTimerCount, _testReset } from '../src/domain/remote/client-lifecycle.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
let restoreAuth: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  _testReset();
  hooks.intent.mockReturnValue({ device: 'local' });
  hooks.online.mockReturnValue(false);
  hooks.port.mockReturnValue(4312);
  _setMachineRegistryProviderForTesting(() => ({ local: { cortexPath: DATA_DIR, gpuCount: 0 } }));
  hooks.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  restoreAuth = captureAuthTokensForRuntime({ env: { CORTEX_CLIENT_TOKEN: 'isolated-token', CORTEX_WEBHOOK_TOKEN: 'isolated-webhook' }, scrubEnv: true });
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(join(STORE_DIR, 'client-pids.json'), '{}');
});
afterEach(() => { _testReset(); restoreAuth(); vi.unstubAllEnvs(); vi.useRealTimers(); });

test('actual lifecycle recovers explicit home and spawns server Node with captured token/env only', async () => {
  vi.stubEnv('CORTEX_CLIENT_TOKEN', undefined);
  vi.stubEnv('Path', 'private-node;private-git');
  vi.stubEnv('CORTEX_GIT_BASH_PATH', 'private-git/bash.exe');
  vi.stubEnv('npm_config_prefix', 'private-npm');
  await Promise.all([startRemoteClient('local'), startRemoteClient('local')]);
  expect(hooks.recover).toHaveBeenCalledWith({ DATA_DIR, CONFIG_DIR }, 'local');
  expect(hooks.spawn).toHaveBeenCalledOnce();
  expect(hooks.spawn).toHaveBeenCalledWith(process.execPath, [join(DATA_DIR, 'client/current/client.mjs')], expect.objectContaining({
    detached: true, stdio: 'ignore', env: expect.objectContaining({
      CORTEX_HOME: DATA_DIR, CORTEX_CLIENT_TOKEN: 'isolated-token', CORTEX_SERVER_URL: 'ws://127.0.0.1:4312',
      Path: 'private-node;private-git', CORTEX_GIT_BASH_PATH: 'private-git/bash.exe', npm_config_prefix: 'private-npm',
    }),
  }));
  expect(JSON.stringify(hooks.spawn.mock.calls[0].slice(0, 2))).not.toContain('isolated-token');
  expect(_getRestartTimerCount()).toBe(1);
});
test('warm hello-online does not spawn or touch prepared files', async () => {
  hooks.online.mockReturnValue(true);
  await startRemoteClient('local');
  expect(hooks.spawn).not.toHaveBeenCalled();
  expect(hooks.recover).not.toHaveBeenCalled();
});
test('bad payload recovery schedules existing retry without launching', async () => {
  hooks.recover.mockRejectedValueOnce(new Error('bad payload'));
  await startRemoteClient('local');
  expect(hooks.spawn).not.toHaveBeenCalled();
  expect(_getRestartTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(hooks.spawn).toHaveBeenCalledOnce();
});
test('hub stop cancels pending recovery continuation and does not rearm retries', async () => {
  let finish!: () => void;
  hooks.recover.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const pending = startRemoteClient('local');
  await hooks.lifecycle!.onStop();
  finish();
  await pending;
  expect(hooks.spawn).not.toHaveBeenCalled();
  expect(_getRestartTimerCount()).toBe(0);
});
test.each([{ ssh: 'remote' }, { clientCommand: 'custom' }])('changed owned machine %j cannot be launched/adopted', async extra => {
  _setMachineRegistryProviderForTesting(() => ({ local: { cortexPath: DATA_DIR, gpuCount: 0, ...extra } }));
  await startRemoteClient('local');
  expect(hooks.spawn).not.toHaveBeenCalled();
  expect(hooks.recover).not.toHaveBeenCalled();
  expect(_getRestartTimerCount()).toBe(1);
});
