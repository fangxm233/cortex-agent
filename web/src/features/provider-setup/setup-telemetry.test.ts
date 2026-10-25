import { afterEach, describe, expect, it, vi } from 'vitest';
import { setupTelemetry, telemetryAnswer } from './setup-telemetry';

type NativeGlobal = typeof globalThis & { __TAURI__?: unknown };
const shell = globalThis as NativeGlobal;

afterEach(() => {
  setupTelemetry.set(true, 'en');
  delete shell.__TAURI__;
});

describe('setup telemetry opt-in', () => {
  it('is on by default and follows the checkbox into the init answers', () => {
    expect(telemetryAnswer()).toEqual({ enabled: true });
    const listener = vi.fn();
    const stop = setupTelemetry.subscribe(listener);
    setupTelemetry.set(false, 'zh');
    stop();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(telemetryAnswer()).toEqual({ enabled: false });
  });

  it('tells the shell every change and the choice in force when an install starts', () => {
    const invoke = vi.fn(async () => null);
    shell.__TAURI__ = { core: { invoke } };
    setupTelemetry.set(false, 'zh');
    setupTelemetry.sync('zh');
    expect(invoke.mock.calls).toEqual([
      ['setup_telemetry_consent', { enabled: false, lang: 'zh' }],
      ['setup_telemetry_consent', { enabled: false, lang: 'zh' }],
    ]);
  });
});
