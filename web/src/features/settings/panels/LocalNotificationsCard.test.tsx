// input:  react-test-renderer, local notification settings
// output: Permission gesture and local preference tests
// pos:    Device notification settings regression coverage
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ lang: 'en', nativeGranted: false, nativeRequest: vi.fn() }));
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: async () => h.nativeGranted,
  requestPermission: h.nativeRequest,
}));
vi.mock('@/i18n', () => ({ useLang: () => h.lang }));
import { LocalNotificationsCard } from './LocalNotificationsCard';
const request = vi.fn(); let mounted: ReactTestRenderer;
class FakeNotification {
  static permission = 'default';
  static requestPermission = request;
}
beforeEach(() => {
  h.lang = 'en'; FakeNotification.permission = 'default'; request.mockReset();
  request.mockImplementation(async () => { FakeNotification.permission = 'granted'; return 'granted'; });
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('window', new EventTarget()); vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('isSecureContext', true); vi.stubGlobal('Notification', FakeNotification);
});
afterEach(() => { if (mounted) act(() => mounted.unmount()); vi.unstubAllGlobals(); });
const mount = async () => { await act(async () => { mounted = create(<LocalNotificationsCard />); }); };
it('starts enabled but unauthorized and requests only on explicit allow click', async () => {
  await mount();
  expect(mounted.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(true);
  expect(JSON.stringify(mounted.toJSON())).toContain('Not authorized');
  expect(request).not.toHaveBeenCalled();
  await act(async () => { mounted.root.findByProps({ 'data-allow-notifications': true }).props.onClick(); });
  expect(request).toHaveBeenCalledOnce();
  expect(JSON.stringify(mounted.toJSON())).toContain('Allowed');
});
it('persists local disable and never prompts from the toggle', async () => {
  await mount();
  act(() => mounted.root.findByProps({ role: 'switch' }).props.onClick());
  expect(mounted.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(false);
  act(() => mounted.unmount()); await mount();
  expect(mounted.root.findByProps({ role: 'switch' }).props['aria-checked']).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it('shows denied instructions and unsupported state without an allow button', async () => {
  FakeNotification.permission = 'denied'; await mount();
  expect(JSON.stringify(mounted.toJSON())).toContain('browser settings');
  expect(mounted.root.findAllByProps({ 'data-allow-notifications': true })).toHaveLength(0);
  vi.stubGlobal('Notification', undefined);
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(JSON.stringify(mounted.toJSON())).toContain('Unavailable');
});
it('reads desktop permission without requesting and offers explicit authorization', async () => {
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  h.nativeGranted = false;
  h.nativeRequest.mockImplementation(async () => { h.nativeGranted = true; return 'granted'; });
  await mount();
  expect(h.nativeRequest).not.toHaveBeenCalled();
  expect(JSON.stringify(mounted.toJSON())).toContain('Not authorized');
  await act(async () => {
    mounted.root.findByProps({ 'data-allow-notifications': true }).props.onClick();
    await vi.waitFor(() => expect(h.nativeRequest).toHaveBeenCalledOnce());
  });
  expect(request).not.toHaveBeenCalled();
  expect(JSON.stringify(mounted.toJSON())).toContain('Allowed');
});
it('renders Chinese and leaves Android settings alone', async () => {
  h.lang = 'zh'; await mount();
  expect(JSON.stringify(mounted.toJSON())).toContain('未授权');
  act(() => mounted.unmount()); vi.stubGlobal('__CORTEX_MOBILE__', true); await mount();
  expect(mounted.toJSON()).toBeNull();
});
