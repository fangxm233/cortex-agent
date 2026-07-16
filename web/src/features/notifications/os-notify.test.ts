import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NotificationItem } from './notification-vm';

// Hoisted mock state so vi.mock factories (hoisted above imports) can read it.
const h = vi.hoisted(() => ({
  native: false,
  granted: true,
  permissionState: 'granted' as 'granted' | 'denied' | 'default',
  sent: [] as Array<{ title?: string; body?: string; extra?: Record<string, unknown> }>,
  throwOnSend: false,
  actionCb: null as null | ((n: { extra?: Record<string, unknown> }) => void),
  unregistered: 0,
}));

vi.mock('@/lib/desktop-config', () => ({
  isNativeShell: () => h.native,
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
    return { unregister: async () => { h.unregistered++; } };
  },
}));

import {
  osNotificationSpec,
  osNotifyAvailable,
  ensureOsNotifyPermission,
  sendOsNotification,
  onOsNotificationAction,
  __resetOsNotifyPermissionForTest,
} from './os-notify';

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

beforeEach(() => {
  h.native = false;
  h.granted = true;
  h.permissionState = 'granted';
  h.sent = [];
  h.throwOnSend = false;
  h.actionCb = null;
  h.unregistered = 0;
  __resetOsNotifyPermissionForTest();
});

describe('osNotificationSpec (pure)', () => {
  it('maps title + meta into an OS title/body', () => {
    expect(osNotificationSpec(item())).toEqual({
      title: '线程完成 — orchard-pipeline',
      body: '评审通过 · 42m · 轻点查看产物',
    });
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
