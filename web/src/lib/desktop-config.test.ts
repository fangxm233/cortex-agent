import { describe, it, expect, afterEach } from 'vitest';
import { readDesktopConfig, isDesktopShell, isMobileShell, isNativeShell, apiBase, authHeaders } from './desktop-config';

// Tests run in the vitest Node environment (no jsdom). readDesktopConfig() reads
// from globalThis (≡ window in browsers), so we can mock the global directly here.

type MockGlobal = typeof globalThis & {
  __CORTEX_DESKTOP_CONFIG?: { serverUrl?: string | null; token?: string | null };
  __CORTEX_DESKTOP__?: boolean;
  __CORTEX_MOBILE__?: boolean;
};

describe('isDesktopShell', () => {
  afterEach(() => {
    delete (globalThis as MockGlobal).__CORTEX_DESKTOP__;
  });

  it('returns true when the Tauri init script set __CORTEX_DESKTOP__', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP__ = true;
    expect(isDesktopShell()).toBe(true);
  });

  it('returns false in browser / ui-http mode (flag absent)', () => {
    expect(isDesktopShell()).toBe(false);
  });
});

describe('isNativeShell', () => {
  afterEach(() => {
    delete (globalThis as MockGlobal).__CORTEX_DESKTOP__;
    delete (globalThis as MockGlobal).__CORTEX_MOBILE__;
  });

  it('returns true in the desktop shell (only __CORTEX_DESKTOP__ set)', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP__ = true;
    expect(isNativeShell()).toBe(true);
  });

  it('returns true in the Android/mobile shell (only __CORTEX_MOBILE__ set)', () => {
    (globalThis as MockGlobal).__CORTEX_MOBILE__ = true;
    expect(isMobileShell()).toBe(true);
    expect(isNativeShell()).toBe(true);
  });

  it('returns false in browser / ui-http mode (neither flag set)', () => {
    expect(isNativeShell()).toBe(false);
  });
});

describe('readDesktopConfig', () => {
  afterEach(() => {
    delete (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG;
  });

  it('returns RemoteConfig when both serverUrl and token are present', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG = {
      serverUrl: 'https://cortex.example.com',
      token: 'tok-abc123',
    };
    expect(readDesktopConfig()).toEqual({
      serverUrl: 'https://cortex.example.com',
      token: 'tok-abc123',
    });
  });

  it('returns undefined when the global is not set', () => {
    expect(readDesktopConfig()).toBeUndefined();
  });

  it('returns undefined when serverUrl is null', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG = { serverUrl: null, token: 'tok-abc' };
    expect(readDesktopConfig()).toBeUndefined();
  });

  it('returns undefined when token is null', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG = {
      serverUrl: 'https://cortex.example.com',
      token: null,
    };
    expect(readDesktopConfig()).toBeUndefined();
  });

  it('returns undefined when token is absent (field omitted)', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG = {
      serverUrl: 'https://cortex.example.com',
    };
    expect(readDesktopConfig()).toBeUndefined();
  });

  it('returns undefined when serverUrl is empty string', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG = { serverUrl: '', token: 'tok-abc' };
    expect(readDesktopConfig()).toBeUndefined();
  });
});

// apiBase()/authHeaders() drive the non-tRPC HTTP transport (file download in lib/files.ts + the
// attachment upload XHR in Composer/MChatScreen). A relative URL + no token would, in a native shell,
// hit the local cortexui:// asset handler instead of the remote server — the mobile-upload bug.
describe('apiBase / authHeaders (non-tRPC transport)', () => {
  afterEach(() => {
    delete (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG;
  });

  it('browser/ui-http mode: empty base + no auth header (same-origin, proxy/Access supplies auth)', () => {
    expect(apiBase()).toBe('');
    expect(authHeaders()).toEqual({});
  });

  it('native-shell/remote mode: absolute server base + x-cortex-token header', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG = { serverUrl: 'https://cortex.example.com', token: 'tok' };
    expect(apiBase()).toBe('https://cortex.example.com');
    expect(authHeaders()).toEqual({ 'x-cortex-token': 'tok' });
  });

  it('partial config (serverUrl without token) falls back to browser mode', () => {
    (globalThis as MockGlobal).__CORTEX_DESKTOP_CONFIG = { serverUrl: 'https://cortex.example.com' };
    expect(apiBase()).toBe('');
    expect(authHeaders()).toEqual({});
  });
});
