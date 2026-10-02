import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SystemUpdateCheckResult } from '@cortex-agent/ui-contract';
import { subscribeManualCheckResult } from '@/lib/manual-update-check-result';
import { checkForUpdates, checkFrontendUpdates, getManualCheckBusy } from './manual-update-check';

const browser = vi.hoisted(() => ({ check: vi.fn().mockResolvedValue({ status: 'current' }) }));
vi.mock('@/features/hot-update/browser-update', () => ({ checkBrowserUpdate: browser.check }));
const current = { ui: { status: 'current' }, shell: { status: 'current' } };
const checkServer = vi.fn().mockResolvedValue({ status: 'current' });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
function transport(invoke = vi.fn().mockResolvedValue(current)) {
  vi.stubGlobal('__CORTEX_DESKTOP__', true);
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  return invoke;
}

describe('manual update check', () => {
  it('checks server first, coalesces overlapping native checks and never applies', async () => {
    let finish!: (value: SystemUpdateCheckResult) => void;
    const server = vi.fn(() => new Promise<SystemUpdateCheckResult>((resolve) => { finish = resolve; }));
    const invoke = transport();
    const first = checkForUpdates(server);
    expect(getManualCheckBusy()).toBe(true);
    expect(checkForUpdates(server)).toBe(first);
    expect(invoke).not.toHaveBeenCalled();
    finish({ status: 'available', update: { version: 'next' } });
    expect(await first).toEqual({ ...current, server: { status: 'available', update: { version: 'next' } } });
    expect(getManualCheckBusy()).toBe(false);
    expect(server).toHaveBeenCalledOnce();
    expect(invoke.mock.calls).toEqual([['check_for_updates', undefined]]);
  });
  it('checks server and page in browsers, coalesces and never invokes native commands', async () => {
    const invoke = vi.fn();
    vi.stubGlobal('__TAURI__', { core: { invoke } });
    const first = checkForUpdates(checkServer);
    expect(checkForUpdates(checkServer)).toBe(first);
    expect(await first).toEqual({ server: { status: 'current' }, ui: { status: 'current' } });
    expect(browser.check).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('rechecks frontend only after reconnect, without recursively checking server', async () => {
    transport();
    expect(await checkFrontendUpdates()).toEqual(current);
    expect(checkServer).not.toHaveBeenCalled();
  });
  it('reports thrown server errors and still checks remaining channels', async () => {
    transport();
    const report = await checkForUpdates(async () => { throw new Error('private address'); });
    expect(report).toEqual({ ...current, server: { status: 'error', reason: 'check_failed' } });
  });
  it.each(['disabled', 'dev_mode', 'version_skipped', 'update_in_progress'])('preserves server skipped reason %s', async (reason) => {
    transport();
    expect((await checkForUpdates(async () => ({ status: 'skipped', reason }))).server).toEqual({ status: 'skipped', reason });
  });
  it('reports missing native command honestly', async () => {
    transport(vi.fn().mockRejectedValue('Command check_for_updates not found'));
    expect((await checkForUpdates(checkServer)).shell).toEqual({ status: 'error', reason: 'unsupported_shell' });
  });
  it('publishes server outcomes and cached fallback once, and cleans subscriptions', async () => {
    transport(vi.fn().mockResolvedValue({
      ui: { status: 'error', reason: 'offline', update: { version: 'cached', fromVersion: null, size: 0 } },
      shell: { status: 'skipped', reason: 'no_matching_asset' },
    }));
    const receive = vi.fn();
    const off = subscribeManualCheckResult(receive);
    const result = await checkForUpdates(checkServer);
    expect(result.ui).toMatchObject({ status: 'error', update: { version: 'cached' } });
    expect(receive).toHaveBeenCalledWith(result);
    off();
    await checkForUpdates(checkServer);
    expect(receive).toHaveBeenCalledOnce();
  });
  it.each([{}, { ui: { status: 'available' }, shell: { status: 'current' } }])('rejects invalid native reports', async (value) => {
    transport(vi.fn().mockResolvedValue(value));
    expect((await checkForUpdates(checkServer)).ui).toEqual({ status: 'error', reason: 'invalid_report' });
  });
  it('reports transport errors honestly and permits retry', async () => {
    const invoke = transport(vi.fn().mockRejectedValue(new Error('offline')));
    expect((await checkForUpdates(checkServer)).shell?.status).toBe('error');
    invoke.mockResolvedValue(current);
    expect(await checkForUpdates(checkServer)).toEqual({ ...current, server: { status: 'current' } });
  });
});
