import { beforeEach, expect, test, vi } from 'vitest';
const hooks = vi.hoisted(() => ({ begin: vi.fn(), complete: vi.fn() }));
vi.mock('../src/domain/remote/local-client-install.js', () => ({
  beginLocalClientInstall: hooks.begin, completeLocalClientInstall: hooks.complete,
}));
import { withInitLocalClient } from '../src/entry/init-local-client.js';
const paths = { DATA_DIR: '/isolated/custom-home', CONFIG_DIR: '/isolated/custom-home/config' };
beforeEach(() => vi.resetAllMocks());

test('passes explicit init paths and persists intent before config writes, then emits preparation', async () => {
  const order: string[] = [];
  hooks.begin.mockImplementation(async () => { order.push('intent'); });
  hooks.complete.mockImplementation(async () => { order.push('files'); });
  const emit = vi.fn();
  await withInitLocalClient(paths, { machineName: 'test', localClient: { enabled: true } }, () => { order.push('config'); }, emit);
  expect(order).toEqual(['intent', 'config', 'files']);
  expect(hooks.begin).toHaveBeenCalledWith(paths, 'test');
  expect(hooks.complete).toHaveBeenCalledWith(paths, 'test');
  expect(emit).toHaveBeenCalledWith({ step: 'local-client', state: 'ok', device: 'test' });
});
test('real preparation failure propagates and emits failure, never writes init config', async () => {
  hooks.begin.mockRejectedValue(new Error('bad payload'));
  const write = vi.fn();
  const emit = vi.fn();
  await expect(withInitLocalClient(paths, { machineName: 'test', localClient: { enabled: true } }, write, emit)).rejects.toThrow('bad payload');
  expect(write).not.toHaveBeenCalled();
  expect(emit).toHaveBeenCalledWith({ step: 'local-client', state: 'error', reason: 'bad payload' });
});
test.each([undefined, { enabled: false }])('ordinary init %j only runs existing config writes', async localClient => {
  const write = vi.fn();
  const emit = vi.fn();
  await withInitLocalClient(paths, { machineName: 'test', localClient }, write, emit);
  expect(write).toHaveBeenCalledOnce();
  expect(hooks.begin).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});
