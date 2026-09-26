import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { browserPermission, createBrowserNotifications, requestBrowserPermission } from './browser-notifications';
import { localNotificationsEnabled, setLocalNotificationsEnabled } from './local-notification-state';

const request = vi.fn(async () => 'granted' as NotificationPermission);
const focus = vi.fn();
const notices: FakeNotification[] = [];
class FakeNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = request;
  onclick: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onshow: (() => void) | null = null;
  close = vi.fn();
  constructor(public title: string, public options: NotificationOptions) {
    notices.push(this);
    queueMicrotask(() => this.onshow?.());
  }
}
beforeEach(() => {
  vi.clearAllMocks(); notices.length = 0;
  FakeNotification.permission = 'default';
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', Object.assign(new EventTarget(), { focus }));
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => vi.unstubAllGlobals());

it('defaults enabled, persists disabling independently of permission', () => {
  expect(localNotificationsEnabled()).toBe(true);
  setLocalNotificationsEnabled(false);
  expect(localNotificationsEnabled()).toBe(false);
  expect(browserPermission()).toBe('default');
  expect(request).not.toHaveBeenCalled();
});
it('never requests permission during delivery; only explicit requests prompt', async () => {
  const adapter = createBrowserNotifications();
  expect(await adapter.send({ title: 'Reply', body: 'Done' }, vi.fn())).toBe(false);
  expect(request).not.toHaveBeenCalled();
  await expect(requestBrowserPermission()).resolves.toBe('granted');
  expect(request).toHaveBeenCalledOnce();
});
it.each(['denied', 'default'] as const)('falls back when permission is %s', async (permission) => {
  FakeNotification.permission = permission;
  expect(await createBrowserNotifications().send({ title: 'A', body: 'B' }, vi.fn())).toBe(false);
  expect(notices).toHaveLength(0);
});
it('requires secure context and a supported constructor', () => {
  vi.stubGlobal('isSecureContext', false);
  expect(browserPermission()).toBe('unsupported');
  vi.stubGlobal('isSecureContext', true); vi.stubGlobal('Notification', undefined);
  expect(browserPermission()).toBe('unsupported');
});
it('focuses and routes clicks, then detaches and closes all notices on disposal', async () => {
  FakeNotification.permission = 'granted';
  const adapter = createBrowserNotifications(); const route = vi.fn();
  expect(await adapter.send({ title: 'Reply', body: 'Done' }, route)).toBe(true);
  const click = notices[0].onclick!;
  click(); expect(focus).toHaveBeenCalledOnce(); expect(route).toHaveBeenCalledOnce();
  adapter.dispose(); expect(notices[0].onclick).toBeNull();
  expect(notices[0].close).toHaveBeenCalled();
  click(); expect(route).toHaveBeenCalledOnce();
});
it('does not focus or route stale-connection notifications', async () => {
  FakeNotification.permission = 'granted';
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'one' });
  const route = vi.fn(); const adapter = createBrowserNotifications();
  await adapter.send({ title: 'A', body: 'B' }, route);
  vi.stubGlobal('__CORTEX_DESKTOP_CONFIG', { serverUrl: 'https://a', token: 'two' });
  notices[0].onclick!();
  expect(route).not.toHaveBeenCalled(); expect(focus).not.toHaveBeenCalled();
  adapter.dispose();
});
it('falls back on asynchronous browser delivery errors', async () => {
  FakeNotification.permission = 'granted';
  const adapter = createBrowserNotifications();
  const sent = adapter.send({ title: 'A', body: 'B' }, vi.fn());
  notices[0].onerror?.();
  expect(await sent).toBe(false);
  expect(notices[0].close).toHaveBeenCalled();
  adapter.dispose();
});
it('falls back when mobile browsers reject the Notification constructor', async () => {
  vi.stubGlobal('Notification', Object.assign(function () { throw new TypeError('Illegal constructor'); },
    { permission: 'granted' }));
  expect(await createBrowserNotifications().send({ title: 'A', body: 'B' }, vi.fn())).toBe(false);
});
it('settles pending sends and detaches delivery events when disposed before display', async () => {
  FakeNotification.permission = 'granted';
  const adapter = createBrowserNotifications();
  const sent = adapter.send({ title: 'A', body: 'B' }, vi.fn());
  adapter.dispose();
  expect(await sent).toBe(false);
  expect(notices[0].onshow).toBeNull();
  expect(notices[0].onerror).toBeNull();
});
