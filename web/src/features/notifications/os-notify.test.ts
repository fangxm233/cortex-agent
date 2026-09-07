// input:  shell flags, native commands and installed plugin events
// output: post fallback, permission and nested tap regressions
// pos:    OS notification compatibility boundary tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NotificationItem } from './notification-vm';

// Hoisted mock state so vi.mock factories (hoisted above imports) can read it.
const h = vi.hoisted(() => ({
  native: false,
  mobile: false,
  granted: true,
  permissionState: 'granted' as 'granted' | 'denied' | 'default',
  sent: [] as Array<{ title?: string; body?: string; extra?: Record<string, unknown> }>,
  throwOnSend: false,
  actionCb: null as null | ((n: { extra?: Record<string, unknown>; notification?: { extra?: Record<string, unknown> } }) => void),
  unregistered: 0,
  registration: null as Promise<void> | null,
  invoke: vi.fn(),
}));

vi.mock('@/lib/desktop-config', () => ({
  isNativeShell: () => h.native,
  isMobileShell: () => h.mobile,
}));

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => h.granted,
  requestPermission: async () => h.permissionState,
  sendNotification: (opts: { title?: string; body?: string; extra?: Record<string, unknown> }) => {
    if (h.throwOnSend) throw new Error('plugin error');
    h.sent.push(opts);
  },
  onAction: async (cb: (n: { extra?: Record<string, unknown> }) => void) => {
    h.actionCb = cb;
    await h.registration;
    return { unregister: async () => { h.unregistered++; } };
  },
}));

type OsNotifyModule = typeof import('./os-notify');
let osNotificationSpec: OsNotifyModule['osNotificationSpec'];
let osNotifyAvailable: OsNotifyModule['osNotifyAvailable'];
let ensureOsNotifyPermission: OsNotifyModule['ensureOsNotifyPermission'];
let sendOsNotification: OsNotifyModule['sendOsNotification'];
let onOsNotificationAction: OsNotifyModule['onOsNotificationAction'];

function item(over: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: 'n1',
    level: 'info',
    title: '线程完成 — orchard-pipeline',
    meta: '评审通过 · 42m · 轻点查看产物',
    ts: '2026-07-15T12:00:00Z',
    sessionId: 's1',
    projectId: 'nimbus',
    ...over,
  };
}

beforeEach(async () => {
  h.native = false;
  h.mobile = false;
  h.registration = null;
  h.invoke.mockReset().mockResolvedValue({});
  vi.stubGlobal('__TAURI__', { core: { invoke: h.invoke } });
  h.granted = true;
  h.permissionState = 'granted';
  h.sent = [];
  h.throwOnSend = false;
  h.actionCb = null;
  h.unregistered = 0;
  vi.resetModules();
  ({
    osNotificationSpec,
    osNotifyAvailable,
    ensureOsNotifyPermission,
    sendOsNotification,
    onOsNotificationAction,
  } = await import('./os-notify'));
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Android native post and permission', () => {
  it('posts through the new plugin even when background service is disabled', async () => {
    h.native = true; h.mobile = true;
    expect(await sendOsNotification({ title: 'Reply', body: 'Done' }, { kind: 'session', sessionId: 's1' })).toBe(true);
    expect(h.invoke).toHaveBeenCalledWith('plugin:cortex-notifications|post', {
      title: 'Reply', body: 'Done', data: { kind: 'session', sessionId: 's1' },
    });
    expect(h.sent).toHaveLength(0);
  });

  it('falls back only for a missing old-APK plugin, not ordinary delivery errors', async () => {
    h.native = true; h.mobile = true;
    h.invoke.mockRejectedValueOnce('plugin cortex-notifications not found');
    expect(await sendOsNotification({ title: 'Reply', body: 'Done' })).toBe(true);
    expect(h.sent).toHaveLength(1);
    h.invoke.mockRejectedValueOnce('notification posting failed');
    expect(await sendOsNotification({ title: 'Reply', body: 'Done' })).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it('rechecks revoked/granted permission without repeating a denied prompt across reloads', async () => {
    h.native = true; h.mobile = true; h.granted = false; h.permissionState = 'denied';
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) });
    const spy = vi.spyOn(await import('@tauri-apps/plugin-notification'), 'requestPermission');
    expect(await ensureOsNotifyPermission()).toBe(false);
    vi.resetModules();
    const fresh = await import('./os-notify');
    expect(await fresh.ensureOsNotifyPermission()).toBe(false);
    h.granted = true;
    expect(await fresh.refreshOsNotifyPermission()).toBe(true);
    h.granted = false;
    expect(await fresh.refreshOsNotifyPermission()).toBe(false);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('osNotifyAvailable', () => {
  it('is false in a plain browser and true in the native shell', () => {
    h.native = false;
    expect(osNotifyAvailable()).toBe(false);
    h.native = true;
    expect(osNotifyAvailable()).toBe(true);
  });
});

describe('off-shell (browser) is a no-op', () => {
  it('ensureOsNotifyPermission returns false without touching the plugin', async () => {
    h.native = false;
    expect(await ensureOsNotifyPermission()).toBe(false);
  });

  it('sendOsNotification returns false and sends nothing', async () => {
    h.native = false;
    expect(await sendOsNotification(osNotificationSpec(item()))).toBe(false);
    expect(h.sent).toHaveLength(0);
  });
});

describe('native shell', () => {
  it('sends when permission is already granted', async () => {
    h.native = true;
    h.granted = true;
    expect(await sendOsNotification(osNotificationSpec(item()))).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ title: '线程完成 — orchard-pipeline', body: '评审通过 · 42m · 轻点查看产物' });
  });

  it('shares an in-flight permission prompt with concurrent delivery', async () => {
    h.native = true; h.granted = false;
    let resolve!: (value: 'granted') => void;
    const spy = vi.spyOn(await import('@tauri-apps/plugin-notification'), 'requestPermission')
      .mockImplementation(() => new Promise((done) => { resolve = done; }));
    const permission = ensureOsNotifyPermission();
    await vi.waitFor(() => expect(spy).toHaveBeenCalledOnce());
    const delivery = sendOsNotification({ title: 'Reply', body: 'Done' });
    resolve('granted');
    expect(await permission).toBe(true);
    expect(await delivery).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it('requests permission when undecided, then sends on grant', async () => {
    h.native = true;
    h.granted = false; // not yet granted
    h.permissionState = 'granted'; // user accepts the prompt
    expect(await sendOsNotification(osNotificationSpec(item()))).toBe(true);
    expect(h.sent).toHaveLength(1);
  });

  it('does not send when permission is denied', async () => {
    h.native = true;
    h.granted = false;
    h.permissionState = 'denied';
    expect(await sendOsNotification(osNotificationSpec(item()))).toBe(false);
    expect(h.sent).toHaveLength(0);
  });

  it('caches the permission decision (prompts once)', async () => {
    h.native = true;
    h.granted = false;
    h.permissionState = 'granted';
    const requestSpy = vi.spyOn(await import('@tauri-apps/plugin-notification'), 'requestPermission');
    await ensureOsNotifyPermission();
    await ensureOsNotifyPermission();
    await sendOsNotification(osNotificationSpec(item()));
    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('returns false when the plugin throws on send', async () => {
    h.native = true;
    h.granted = true;
    h.throwOnSend = true;
    expect(await sendOsNotification(osNotificationSpec(item()))).toBe(false);
  });

  it('carries the nav payload through the notification extra', async () => {
    h.native = true;
    h.granted = true;
    await sendOsNotification(osNotificationSpec(item()), { sessionId: 's1', projectId: 'nimbus' });
    expect(h.sent[0].extra).toEqual({ sessionId: 's1', projectId: 'nimbus' });
  });
});

describe('onOsNotificationAction (tap → deep-link)', () => {
  it('removes late legacy listeners and prevents callbacks after abort', async () => {
    h.native = true;
    let resolve!: () => void;
    h.registration = new Promise((done) => { resolve = done; });
    const controller = new AbortController();
    const cb = vi.fn();
    const pending = onOsNotificationAction(cb, controller.signal);
    await vi.waitFor(() => expect(h.actionCb).not.toBeNull());
    controller.abort();
    h.actionCb?.({ extra: { sessionId: 'late' } });
    resolve();
    const off = await pending;
    off(); off();
    expect(cb).not.toHaveBeenCalled();
    expect(h.unregistered).toBe(1);
  });

  it('normalizes the real Android nested action envelope', async () => {
    h.native = true;
    const cb = vi.fn();
    const off = await onOsNotificationAction(cb);
    h.actionCb?.({ notification: { extra: { sessionId: 's7', projectId: 'orchard' } } });
    expect(cb).toHaveBeenCalledWith({ sessionId: 's7', projectId: 'orchard' });
    off();
  });
  it('is a no-op off-shell and never subscribes', async () => {
    h.native = false;
    const cb = vi.fn();
    const off = await onOsNotificationAction(cb);
    expect(h.actionCb).toBeNull();
    off();
    expect(h.unregistered).toBe(0);
  });

  it('delivers the tapped notification extra to the callback in the native shell', async () => {
    h.native = true;
    const cb = vi.fn();
    const off = await onOsNotificationAction(cb);
    expect(h.actionCb).not.toBeNull();
    // Simulate the OS delivering a tap on a notification we sent with this extra.
    h.actionCb?.({ extra: { sessionId: 's7', projectId: 'orchard' } });
    expect(cb).toHaveBeenCalledWith({ sessionId: 's7', projectId: 'orchard' });
    off();
    expect(h.unregistered).toBe(1);
  });
});
