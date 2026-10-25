import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordSetupLang } from './setup-telemetry';

type NativeGlobal = typeof globalThis & { __TAURI__?: unknown };
const shell = globalThis as NativeGlobal;

afterEach(() => { delete shell.__TAURI__; });

describe('setup telemetry', () => {
  it('tells the shell the setup language', () => {
    const invoke = vi.fn(async () => null);
    shell.__TAURI__ = { core: { invoke } };
    recordSetupLang('zh');
    expect(invoke.mock.calls).toEqual([['setup_telemetry_lang', { lang: 'zh' }]]);
  });
});
