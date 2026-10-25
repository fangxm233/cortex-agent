import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientKindHeaders, resetClientKindHeaderForTest } from '@/lib/client-kind';
import { telemetryQueue } from './report-queue';
import { applyTelemetryInfo, forwardNativeCrash } from './telemetry-bridge';

type ShellGlobal = typeof globalThis & { __CORTEX_MOBILE__?: boolean; __TAURI__?: unknown };
const shell = globalThis as ShellGlobal;
const CRASH = { at: '2026-10-24T12:00:00.000Z', message: 'panicked', stack: 'at src/lib.rs:1', appVersion: '2026.10.24' };

function nativeShell(result: unknown) {
  shell.__CORTEX_MOBILE__ = true;
  const invoke = vi.fn(async () => result);
  shell.__TAURI__ = { core: { invoke } };
  return invoke;
}

afterEach(() => {
  delete shell.__CORTEX_MOBILE__;
  delete shell.__TAURI__;
  resetClientKindHeaderForTest();
  vi.restoreAllMocks();
});

describe('telemetry bridge', () => {
  it('attaches the sink while active and detaches it when off', () => {
    const attach = vi.spyOn(telemetryQueue, 'attach').mockImplementation(() => undefined);
    const detach = vi.spyOn(telemetryQueue, 'detach').mockImplementation(() => undefined);
    const sink = vi.fn(async () => undefined);
    applyTelemetryInfo({ active: true }, sink);
    expect(attach).toHaveBeenCalledWith(sink);
    applyTelemetryInfo({ active: false }, sink);
    expect(detach).toHaveBeenCalledTimes(1);
  });

  it('starts sending the native client header once the server answered', () => {
    shell.__CORTEX_MOBILE__ = true;
    vi.spyOn(telemetryQueue, 'detach').mockImplementation(() => undefined);
    expect(clientKindHeaders()).toEqual({});
    applyTelemetryInfo({ active: false }, async () => undefined);
    expect(clientKindHeaders()).toEqual({ 'x-cortex-client': 'android' });
  });

  it('forwards a recorded shell panic once, as the shell it came from', async () => {
    const invoke = nativeShell(CRASH);
    const enqueue = vi.fn();
    await forwardNativeCrash(enqueue, true);
    expect(invoke).toHaveBeenCalledWith('telemetry_take_native_crash', undefined);
    expect(enqueue).toHaveBeenCalledWith({ kind: 'native_crash', component: 'android', ...CRASH });
  });

  it('still clears a recorded panic while telemetry is off, without sending it', async () => {
    const invoke = nativeShell(CRASH);
    const enqueue = vi.fn();
    await forwardNativeCrash(enqueue, false);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('does nothing in a browser', async () => {
    const enqueue = vi.fn();
    await forwardNativeCrash(enqueue, true);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
