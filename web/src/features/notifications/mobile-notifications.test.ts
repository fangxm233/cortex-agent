// input:  native status, permission and visibility doubles
// output: service lifecycle, disabled sync and toggle error tests
// pos:    Android notification lifecycle regression tests
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ status: vi.fn(), invoke: vi.fn(), ensure: vi.fn(), refresh: vi.fn(), mobile: true }));
vi.mock('@/lib/desktop-config', () => ({ isMobileShell: () => h.mobile }));
vi.mock('@/lib/native-bridge', () => ({ mobileNotificationStatus: h.status, safeInvoke: h.invoke }));
vi.mock('./os-notify', () => ({ ensureOsNotifyPermission: h.ensure, refreshOsNotifyPermission: h.refresh }));

const status = { enabled: true, running: false, permissionGranted: true, scope: 'server-a' };
let module: typeof import('./mobile-notifications');
let documentTarget: EventTarget & { visibilityState: string };
let off: (() => void) | undefined;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  h.mobile = true;
  h.status.mockResolvedValue(status);
  h.invoke.mockResolvedValue({ ok: true, value: { ...status, running: true } });
  h.ensure.mockResolvedValue(true);
  h.refresh.mockResolvedValue(true);
  documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('window', new EventTarget());
  module = await import('./mobile-notifications');
});
afterEach(() => { off?.(); off = undefined; vi.unstubAllGlobals(); });
const flush = () => new Promise((done) => setTimeout(done, 0));

describe('mobile notification lifecycle', () => {
  it('checks status and permission before visible configuration and rechecks on resume', async () => {
    off = module.startMobileNotifications('zh');
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith('mobile_notifications_configure', { enabled: true, locale: 'zh' }));
    expect(h.status.mock.invocationCallOrder[0]).toBeLessThan(h.ensure.mock.invocationCallOrder[0]);
    expect(h.ensure.mock.invocationCallOrder[0]).toBeLessThan(h.invoke.mock.invocationCallOrder[0]);
    documentTarget.visibilityState = 'hidden';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(h.invoke).toHaveBeenCalledOnce();
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledTimes(2));
    expect(h.ensure).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('does not start without permission and does not prompt again on resume', async () => {
    h.ensure.mockResolvedValue(false);
    h.refresh.mockResolvedValue(false);
    off = module.startMobileNotifications('en');
    await flush();
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(h.ensure).toHaveBeenCalledOnce();
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('syncs credentials with enabled:false so ordinary posts keep working', async () => {
    h.status.mockResolvedValue({ ...status, enabled: false });
    off = module.startMobileNotifications('en');
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith('mobile_notifications_configure', { enabled: false, locale: 'en' }));
  });

  it('does not configure old APKs or browser shells', async () => {
    h.status.mockResolvedValue(null);
    off = module.startMobileNotifications('en');
    await flush();
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.ensure).toHaveBeenCalledOnce(); // Existing reply fallback remains available.
    off();
    h.mobile = false;
    module.startMobileNotifications('en');
    expect(h.status).toHaveBeenCalledOnce();
  });

  it('does not start after permission resolves on a hidden or unmounted page', async () => {
    let resolve!: (value: boolean) => void;
    h.ensure.mockImplementation(() => new Promise((done) => { resolve = done; }));
    off = module.startMobileNotifications('en');
    await vi.waitFor(() => expect(h.ensure).toHaveBeenCalledOnce());
    documentTarget.visibilityState = 'hidden';
    resolve(true);
    await flush();
    expect(h.invoke).not.toHaveBeenCalled();
    off();
    documentTarget.visibilityState = 'visible';
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(h.status).toHaveBeenCalledOnce();
  });

  it('does not enable if the page hides while the permission check is pending', async () => {
    let resolve!: (value: boolean) => void;
    h.refresh.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const pending = module.setMobileNotificationsEnabled(true, 'en');
    await vi.waitFor(() => expect(h.refresh).toHaveBeenCalledOnce());
    documentTarget.visibilityState = 'hidden';
    resolve(true);
    await pending;
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('serializes a toggle behind reconciliation and blocks denied enable without prompting', async () => {
    off = module.startMobileNotifications('en');
    await flush();
    await module.setMobileNotificationsEnabled(false, 'zh');
    expect(h.invoke).toHaveBeenLastCalledWith('mobile_notifications_configure', { enabled: false, locale: 'zh' });
    h.refresh.mockResolvedValue(false);
    h.invoke.mockClear();
    await module.setMobileNotificationsEnabled(true, 'zh');
    expect(h.invoke).not.toHaveBeenCalled();
    expect(h.ensure).toHaveBeenCalledOnce();
  });
});
