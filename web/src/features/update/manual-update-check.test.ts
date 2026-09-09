// input:  real native bridge with mocked Tauri command transport
// output: manual check contract and single-flight regression tests
// pos:    Manual update controller boundary specification
// >>> If updated, update this header and parent CORTEX.md <<<

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkForUpdates, getManualCheckBusy, subscribeManualCheckResult,
} from './manual-update-check';

const current = { ui: { status: 'current' }, shell: { status: 'current' } };
afterEach(() => vi.unstubAllGlobals());

function transport(invoke = vi.fn().mockResolvedValue(current)) {
  vi.stubGlobal('__TAURI__', { core: { invoke } });
  return invoke;
}

describe('manual update check', () => {
  it('runs a fresh typed command, coalesces overlapping checks, and never applies', async () => {
    let finish!: (value: unknown) => void;
    const invoke = transport(vi.fn(() => new Promise((resolve) => { finish = resolve; })));
    const first = checkForUpdates();
    expect(getManualCheckBusy()).toBe(true);
    expect(checkForUpdates()).toBe(first);
    finish(current);
    expect(await first).toEqual(current);
    expect(getManualCheckBusy()).toBe(false);
    expect(invoke.mock.calls).toEqual([['check_for_updates', undefined]]);
  });

  it.each([undefined, 'Command check_for_updates not found'])('never succeeds on an old/missing shell: %s', async (error) => {
    if (error) transport(vi.fn().mockRejectedValue(error));
    expect(await checkForUpdates()).toEqual({
      ui: { status: 'error', reason: 'unsupported_shell' },
      shell: { status: 'error', reason: 'unsupported_shell' },
    });
  });

  it('keeps error-with-cached-update distinct from fresh current and cleans subscriptions', async () => {
    const report = {
      ui: { status: 'error', reason: 'network failed', update: { version: 'cached', fromVersion: null, size: 0 } },
      shell: { status: 'skipped', reason: 'no_matching_asset' },
    };
    const invoke = transport(vi.fn().mockResolvedValue(report));
    const receive = vi.fn();
    const off = subscribeManualCheckResult(receive);
    const result = await checkForUpdates();
    expect(result.ui).toMatchObject({ status: 'error', update: { version: 'cached' } });
    expect(receive).toHaveBeenCalledOnce();
    off();
    await checkForUpdates();
    expect(receive).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([{}, { ui: { status: 'available' }, shell: { status: 'current' } }])('rejects invalid reports', async (value) => {
    transport(vi.fn().mockResolvedValue(value));
    expect((await checkForUpdates()).ui).toEqual({ status: 'error', reason: 'invalid_report' });
  });

  it('reports transport errors honestly and permits retry', async () => {
    const invoke = transport(vi.fn().mockRejectedValue(new Error('offline')));
    expect((await checkForUpdates()).shell.status).toBe('error');
    invoke.mockResolvedValue(current);
    expect(await checkForUpdates()).toEqual(current);
  });
});
