// input:  native state, failed server config and bilingual UI
// output: independent toggle, pending/error and old-APK tests
// pos:    Device-local mobile notification settings regressions
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ status: vi.fn(), invoke: vi.fn(), permission: vi.fn(), locale: 'en', mobile: true }));
vi.mock('@/lib/native-bridge', () => ({ mobileNotificationStatus: h.status, safeInvoke: h.invoke }));
vi.mock('@/lib/desktop-config', () => ({ isMobileShell: () => h.mobile }));
vi.mock('@/features/notifications/os-notify', () => ({ ensureOsNotifyPermission: h.permission, refreshOsNotifyPermission: h.permission }));
vi.mock('@/i18n', async () => {
  const { en, zh } = await import('@/i18n/vocab');
  return { useLang: () => h.locale, useVocab: () => h.locale === 'zh' ? zh : en };
});
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@tanstack/react-query', () => ({ useQuery: () => ({ isError: true }) }));
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({ config: { get: { queryOptions: () => ({}) } } }) }));
vi.mock('@/features/settings/runtime-settings-writer', () => ({ useRuntimeSettingWrite: () => ({ pending: false }) }));
import { startMobileNotifications } from '@/features/notifications/mobile-notifications';
import { MNotificationsScreen } from './MRuntimeSettingsScreen';

const status = { enabled: true, running: true, permissionGranted: true, scope: 'a' };
let renderer: ReactTestRenderer;
let off: () => void;
beforeEach(async () => {
  vi.clearAllMocks();
  h.locale = 'en'; h.mobile = true;
  h.status.mockResolvedValue(status);
  h.permission.mockResolvedValue(true);
  h.invoke.mockResolvedValue({ ok: true, value: status });
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
  vi.stubGlobal('window', new EventTarget());
  await act(async () => { off = startMobileNotifications('en'); await new Promise((done) => setTimeout(done, 0)); });
  act(() => { renderer = create(<MNotificationsScreen />); });
});
afterEach(() => { act(() => renderer.unmount()); off(); vi.unstubAllGlobals(); });

describe('native device notification settings', () => {
  it('remains available when server config fails and shows toggle failures without flipping', async () => {
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);
    h.invoke.mockResolvedValue({ ok: false, reason: 'failed', error: 'native failure' });
    await act(async () => { renderer.root.findByProps({ role: 'switch' }).props.onClick(); });
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);
    expect(renderer.root.findByProps({ role: 'alert' }).children.length).toBeGreaterThan(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('Could not update device notifications. Try again.');
    expect(h.invoke).toHaveBeenLastCalledWith('mobile_notifications_configure', { enabled: false, locale: 'en' });
  });

  it('disables pending writes and renders Chinese status/copy', async () => {
    let resolve!: (value: unknown) => void;
    h.invoke.mockImplementation(() => new Promise((done) => { resolve = done; }));
    act(() => renderer.root.findByProps({ role: 'switch' }).props.onClick());
    expect(renderer.root.findByProps({ role: 'switch' }).props.disabled).toBe(true);
    await act(async () => { await Promise.resolve(); resolve({ ok: true, value: { ...status, enabled: false, running: false } }); });
    h.locale = 'zh';
    act(() => renderer.update(<MNotificationsScreen />));
    expect(renderer.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(false);
    expect(JSON.stringify(renderer.toJSON())).toContain('本设备后台通知');
    expect(JSON.stringify(renderer.toJSON())).toContain('后台服务已关闭');
  });

  it('hides the local card on unsupported old APKs and browsers', async () => {
    off(); h.status.mockResolvedValue(null);
    await act(async () => { off = startMobileNotifications('en'); await new Promise((done) => setTimeout(done, 0)); });
    expect(renderer.root.findAllByProps({ role: 'switch' })).toHaveLength(0);
    h.mobile = false;
    act(() => renderer.update(<MNotificationsScreen />));
    expect(renderer.root.findAllByProps({ role: 'switch' })).toHaveLength(0);
  });
});
