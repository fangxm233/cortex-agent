import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ intent: vi.fn(), validate: vi.fn(), payload: vi.fn(), register: vi.fn(), online: vi.fn(() => []), registry: vi.fn(), machines: vi.fn() }));
vi.mock('../src/domain/remote/local-client-install.js', () => ({ readLocalClientIntent: hooks.intent, validateLocalClientOwnership: hooks.validate }));
vi.mock('../src/domain/remote/package-client-bundle.js', () => ({ loadPackageClientBundle: hooks.payload }));
vi.mock('../src/domain/remote/client-manager.js', () => ({ setClientUpdateHooks: hooks.register, getOnlineDevices: hooks.online, sendControlMessage: vi.fn() }));
vi.mock('@core/exec-async.js', () => ({ runFile: hooks.registry, runShell: hooks.registry }));
vi.mock('../src/domain/remote/machine-registry.js', () => ({ getMachineRegistry: hooks.machines }));
import { DATA_DIR } from '../src/core/paths.js';
import { initClientHotReload, _onHelloForTesting as hello, _setBundleForTesting, _setSendForTesting, _testReset } from '../src/domain/remote/client-hot-reload.js';
const packaged = { version: '2.0.0', hash: 'package-local', files: [] };
const published = { version: '1.0.0', hash: 'npm-latest', files: [] };
const send = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  _testReset();
  hooks.intent.mockReturnValue({ device: 'local' });
  hooks.payload.mockReturnValue(packaged);
  hooks.machines.mockReturnValue({ local: { cortexPath: DATA_DIR, gpuCount: 0 }, remote: { ssh: 'external-host' } });
  _setSendForTesting(send);
});
afterEach(() => _testReset());

test('owned local hello uses package payload before registry resolves', () => {
  hello('local', 'old');
  expect(send).toHaveBeenCalledWith('local', expect.objectContaining({ hash: 'package-local' }));
});
test('npm latest never downgrades an owned local hello', () => {
  _setBundleForTesting(published);
  hello('local', 'package-local');
  expect(send).not.toHaveBeenCalled();
  hello('local', 'old');
  expect(send).toHaveBeenCalledWith('local', expect.objectContaining({ hash: 'package-local' }));
});
test('missing/broken local payload fails closed without registry fallback', () => {
  _setBundleForTesting(published);
  hooks.payload.mockImplementation(() => { throw new Error('bad package'); });
  hello('local', 'old');
  expect(send).not.toHaveBeenCalled();
});
test('external/remote devices retain existing desired bundle', () => {
  _setBundleForTesting(published);
  hello('remote', 'old');
  expect(send).toHaveBeenCalledWith('remote', expect.objectContaining({ hash: 'npm-latest' }));
  expect(hooks.payload).not.toHaveBeenCalled();
});
test('a broken local ownership marker cannot disable unrelated SSH client updates', () => {
  _setBundleForTesting(published);
  hooks.intent.mockImplementation(() => { throw new Error('invalid local ownership'); });
  hello('remote', 'old');
  expect(send).toHaveBeenCalledWith('remote', expect.objectContaining({ hash: 'npm-latest' }));
  hello('local', 'old');
  expect(send).toHaveBeenCalledTimes(1);
});
test('direct-WS remote path uses the global bundle without reading invalid local intent', () => {
  _setBundleForTesting(published);
  hooks.machines.mockReturnValue({ remote: { cortexPath: '/external/cortex', gpuCount: 0, clientConnection: 'direct' } });
  hooks.intent.mockImplementation(() => { throw new Error('invalid local ownership'); });
  hello('remote', 'old');
  expect(send).toHaveBeenCalledWith('remote', expect.objectContaining({ hash: 'npm-latest' }));
  expect(hooks.intent).not.toHaveBeenCalled();
  expect(hooks.payload).not.toHaveBeenCalled();
});
test.each([DATA_DIR, undefined])('invalid intent fails closed for candidate with path %s', cortexPath => {
  _setBundleForTesting(published);
  hooks.machines.mockReturnValue({ local: { cortexPath, gpuCount: 0 } });
  hooks.intent.mockImplementation(() => { throw new Error('invalid local ownership'); });
  hello('local', 'old');
  expect(hooks.intent).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  expect(hooks.payload).not.toHaveBeenCalled();
});
test('unestablished local ownership never falls back to the package bundle', () => {
  _setBundleForTesting(published);
  hooks.validate.mockImplementationOnce(() => { throw new Error('machine ownership conflict'); });
  hello('local', 'old');
  expect(send).not.toHaveBeenCalled();
  expect(hooks.payload).not.toHaveBeenCalled();
});
test('first online sweep is independent of a never-resolving npm query', async () => {
  hooks.online.mockReturnValue([{ device: 'local', bundleHash: 'old' }] as never);
  hooks.registry.mockImplementation(() => new Promise(() => {}));
  initClientHotReload(() => {});
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(send).toHaveBeenCalledWith('local', expect.objectContaining({ hash: 'package-local' }));
});
