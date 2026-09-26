// input:  vitest, desktop adapter, native bridge
// output: Native delivery, activation and retry regression tests
// pos:    Desktop bridge recovery and cleanup coverage
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listenDesktopNotificationActions, sendDesktopNotification } from './desktop-notifications';
const legacy = vi.hoisted(() => vi.fn(async () => true));
vi.mock('./os-notify', () => ({ sendOsNotification: legacy }));
const invoke = vi.fn(); const off = vi.fn(); const listen = vi.fn();
const action = { actionId: 'a1', serverUrl: 'https://a', sessionId: 's1' };
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('__TAURI__', { core: { invoke }, event: { listen } });
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'one' });
  invoke.mockImplementation(async (cmd) => cmd === 'desktop_notifications_pending' ? { actions: [action] } : undefined);
  listen.mockResolvedValue(off);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
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
it('retries a rejected click lookup without another notification and only then acknowledges', async () => {
  vi.useFakeTimers();
  invoke.mockResolvedValueOnce({ actions: [] });
  const route = vi.fn().mockRejectedValueOnce(new Error('sessions.list offline')).mockResolvedValue(true);
  const cleanup = await listenDesktopNotificationActions(route);
  listen.mock.calls[0][1]({});
  await vi.advanceTimersByTimeAsync(0);
  expect(route).toHaveBeenCalledTimes(1);
  expect(invoke).not.toHaveBeenCalledWith('desktop_notifications_ack', expect.anything());
  await vi.advanceTimersByTimeAsync(999);
  expect(route).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(route).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenLastCalledWith('desktop_notifications_ack', { actionId: 'a1' });
  expect(vi.getTimerCount()).toBe(0);
  cleanup();
});
it.each(['focus', 'online'])('bounds retries at 1/2/4 seconds and resumes on %s', async (event) => {
  vi.useFakeTimers();
  const route = vi.fn().mockRejectedValue(new Error('offline'));
  const cleanup = await listenDesktopNotificationActions(route);
  for (const [index, delay] of [1_000, 2_000, 4_000].entries()) {
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(route).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(route).toHaveBeenCalledTimes(index + 2);
  }
  await vi.advanceTimersByTimeAsync(60_000);
  expect(route).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);
  route.mockResolvedValue(true);
  window.dispatchEvent(new Event(event));
  await vi.advanceTimersByTimeAsync(0);
  expect(route).toHaveBeenCalledTimes(5);
  expect(invoke).toHaveBeenLastCalledWith('desktop_notifications_ack', { actionId: 'a1' });
  cleanup();
});
it.each(['cleanup', 'abort'])('clears retry timers and resume listeners on %s', async (mode) => {
  vi.useFakeTimers();
  const remove = vi.spyOn(window, 'removeEventListener');
  const controller = new AbortController();
  const route = vi.fn().mockRejectedValue(new Error('offline'));
  const cleanup = await listenDesktopNotificationActions(route, controller.signal);
  expect(vi.getTimerCount()).toBe(1);
  if (mode === 'abort') controller.abort();
  else cleanup();
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith('focus', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('online', expect.any(Function));
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  listen.mock.calls[0][1]({});
  await vi.advanceTimersByTimeAsync(60_000);
  expect(route).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(off).toHaveBeenCalledOnce();
});
it('does not retry or resume against a changed connection', async () => {
  vi.useFakeTimers();
  const route = vi.fn().mockRejectedValue(new Error('offline'));
  const cleanup = await listenDesktopNotificationActions(route);
  expect(vi.getTimerCount()).toBe(1);
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'changed' });
  await vi.advanceTimersByTimeAsync(1_000);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(route).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  cleanup();
});
it('does not schedule retries for missing old-shell commands', async () => {
  vi.useFakeTimers();
  invoke.mockRejectedValueOnce('Command desktop_notifications_pending not found');
  const route = vi.fn();
  const cleanup = await listenDesktopNotificationActions(route);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(route).not.toHaveBeenCalled();
  cleanup();
});
it('serializes retry, resume and click drains until successful routing is acknowledged', async () => {
  vi.useFakeTimers();
  let finish!: (success: boolean) => void;
  const route = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  let pending = true;
  invoke.mockImplementation(async (command) => {
    if (command === 'desktop_notifications_ack') pending = false;
    return command === 'desktop_notifications_pending' ? { actions: pending ? [action] : [] } : undefined;
  });
  const cleanup = await listenDesktopNotificationActions(route);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(route).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event('focus'));
  window.dispatchEvent(new Event('online'));
  listen.mock.calls[0][1]({});
  await vi.advanceTimersByTimeAsync(0);
  expect(route).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenCalledTimes(2);
  finish(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(route).toHaveBeenCalledTimes(2);
  expect(invoke.mock.calls.filter(([command]) => command === 'desktop_notifications_ack')).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
  cleanup();
});
it.each(['dispose', 'connection'])('does not acknowledge in-flight routing invalidated by %s', async (mode) => {
  vi.useFakeTimers();
  let finish!: (success: boolean) => void;
  const controller = new AbortController();
  const route = vi.fn().mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const cleanup = await listenDesktopNotificationActions(route, controller.signal);
  await vi.advanceTimersByTimeAsync(1_000);
  if (mode === 'dispose') controller.abort();
  else vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'changed' });
  finish(true);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(invoke).not.toHaveBeenCalledWith('desktop_notifications_ack', expect.anything());
  expect(vi.getTimerCount()).toBe(0);
  cleanup();
});
it('invalidates in-flight routing after connection changes or disposal', async () => {
  let valid: (() => boolean) | undefined;
  const cleanup = await listenDesktopNotificationActions(async (_action, current) => { valid = current; return true; });
  expect(valid?.()).toBe(true);
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'changed' });
  expect(valid?.()).toBe(false);
  cleanup();
});
