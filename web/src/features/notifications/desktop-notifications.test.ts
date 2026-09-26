// input:  vitest, desktop adapter, native bridge
// output: Native delivery and activation regression tests
// pos:    Desktop bridge contract and cleanup coverage
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listenDesktopNotificationActions, sendDesktopNotification } from './desktop-notifications';
const legacy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./os-notify', () => ({ sendOsNotification: legacy }));
const invoke = vi.fn(); const off = vi.fn(); const listen = vi.fn();
const action = { actionId: 'a1', serverUrl: 'https://a', sessionId: 's1' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('__TAURI__', { core: { invoke }, event: { listen } });
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'one' });
  invoke.mockImplementation(async (cmd) => cmd === 'desktop_notifications_pending' ? { actions: [action] } : undefined);
  listen.mockResolvedValue(off);
});
afterEach(() => vi.unstubAllGlobals());
it('posts typed target metadata through the bridge, not stock notification', async () => {
  await expect(sendDesktopNotification({ title: 'A', body: 'B' }, { sessionId: 's1' })).resolves.toBe(true);
  expect(invoke).toHaveBeenCalledWith('desktop_notifications_post', { title: 'A', body: 'B', data: { sessionId: 's1' } });
  expect(legacy).not.toHaveBeenCalled();
});
it('uses stock display only for missing commands, never delivery errors', async () => {
  invoke.mockRejectedValueOnce('permission denied');
  await expect(sendDesktopNotification({ title: 'A', body: 'B' })).resolves.toBe(false);
  expect(legacy).not.toHaveBeenCalled();
  invoke.mockRejectedValueOnce('Command desktop_notifications_post not found');
  await expect(sendDesktopNotification({ title: 'A', body: 'B' })).resolves.toBe(true);
  expect(legacy).toHaveBeenCalledOnce();
});
it('registers before initial drain and acknowledges after routing', async () => {
  const route = vi.fn(async () => true);
  const cleanup = await listenDesktopNotificationActions(route);
  expect(listen).toHaveBeenCalledWith('desktop-notification-action', expect.any(Function));
  expect(route).toHaveBeenCalledWith(action, expect.any(Function));
  expect(invoke).toHaveBeenLastCalledWith('desktop_notifications_ack', { actionId: 'a1' });
  expect(route.mock.invocationCallOrder[0]).toBeLessThan(invoke.mock.invocationCallOrder.at(-1)!);
  cleanup(); expect(off).toHaveBeenCalledOnce();
});
it('drains again on action events, ignoring payload data', async () => {
  invoke.mockResolvedValueOnce({ actions: [] });
  const route = vi.fn(async () => true);
  const cleanup = await listenDesktopNotificationActions(route);
  expect(route).not.toHaveBeenCalled();
  listen.mock.calls[0][1]({ payload: { sessionId: 'untrusted' } });
  await vi.waitFor(() => expect(route).toHaveBeenCalledWith(action, expect.any(Function)));
  cleanup();
});
it('does not invoke legacy when the IPC bridge itself is unavailable', async () => {
  vi.stubGlobal('__TAURI__', undefined);
  await expect(sendDesktopNotification({ title: 'A', body: 'B' })).resolves.toBe(false);
  expect(legacy).not.toHaveBeenCalled();
});
it('does not ack a route that failed and does not route after disposal', async () => {
  const route = vi.fn(async () => false);
  const cleanup = await listenDesktopNotificationActions(route);
  expect(invoke).not.toHaveBeenCalledWith('desktop_notifications_ack', expect.anything());
  cleanup(); route.mockClear();
  listen.mock.calls[0][1]({});
  await Promise.resolve();
  expect(route).not.toHaveBeenCalled();
});
it('drops wrong-server targets without routing', async () => {
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://b', token: 'two' });
  const route = vi.fn(); const cleanup = await listenDesktopNotificationActions(route);
  expect(route).not.toHaveBeenCalled();
  expect(invoke).toHaveBeenLastCalledWith('desktop_notifications_ack', { actionId: 'a1' });
  cleanup();
});
it('cleans up a listener that registers after unmount and never drains', async () => {
  let resolve!: (fn: () => void) => void;
  listen.mockImplementation(() => new Promise((done) => { resolve = done; }));
  const controller = new AbortController();
  const pending = listenDesktopNotificationActions(vi.fn(), controller.signal);
  controller.abort(); resolve(off); await pending;
  expect(off).toHaveBeenCalledOnce(); expect(invoke).not.toHaveBeenCalled();
});
it('invalidates in-flight routing after connection changes or disposal', async () => {
  let valid: (() => boolean) | undefined;
  const cleanup = await listenDesktopNotificationActions(async (_action, current) => { valid = current; return true; });
  expect(valid?.()).toBe(true);
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'changed' });
  expect(valid?.()).toBe(false);
  cleanup();
});
