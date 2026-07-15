import type { RemoteConfig } from './trpc';

/**
 * Read desktop-mode credentials injected by the Tauri initialization_script.
 *
 * The initialization_script runs an async `invoke('get_connection_config')` IPC
 * call that resolves in microseconds — well before the React bundle finishes
 * downloading and this module executes. The resolved value is stored in
 * `window.__CORTEX_DESKTOP_CONFIG` (≡ `globalThis.__CORTEX_DESKTOP_CONFIG`).
 *
 * Returns undefined in browser / ui-http mode (no Tauri shell, global never set).
 *
 * Reads from `globalThis` rather than `window` so this function is testable
 * in the vitest Node environment without requiring jsdom.
 */
export function readDesktopConfig(): RemoteConfig | undefined {
  const cfg = (
    globalThis as unknown as {
      __CORTEX_DESKTOP_CONFIG?: { serverUrl?: string | null; token?: string | null };
    }
  ).__CORTEX_DESKTOP_CONFIG;
  if (cfg?.serverUrl && cfg?.token) {
    return { serverUrl: cfg.serverUrl, token: cfg.token };
  }
  return undefined;
}

/**
 * True when running inside the Tauri desktop shell. The initialization_script sets
 * `window.__CORTEX_DESKTOP__ = true` synchronously (before the React bundle executes),
 * independent of whether credentials are configured yet.
 *
 * Used to pick a HashRouter in desktop mode: the shell loads the SPA via the Tauri asset
 * protocol at `/index.html`, which a BrowserRouter cannot match (→ "404 Not Found"). Hash
 * routing is path-independent. Browser / ui-http mode keeps BrowserRouter (clean URLs).
 */
export function isDesktopShell(): boolean {
  return (globalThis as unknown as { __CORTEX_DESKTOP__?: boolean }).__CORTEX_DESKTOP__ === true;
}

/**
 * True when running inside the dedicated mobile client shell. The mobile shell sets
 * `window.__CORTEX_MOBILE__ = true` synchronously before the bundle executes (mirrors
 * `__CORTEX_DESKTOP__`). This is the ONLY thing that selects the mobile UI — a narrow browser
 * window is NOT mobile. Browser / desktop / ui-http all return false → the desktop UI.
 */
export function isMobileShell(): boolean {
  return (globalThis as unknown as { __CORTEX_MOBILE__?: boolean }).__CORTEX_MOBILE__ === true;
}

/**
 * True when running inside ANY native Tauri shell (desktop OR mobile/Android).
 *
 * Both shells load the SPA over an asset-style protocol at a real file path
 * (`cortexui://localhost/index.html` on desktop, `http://tauri.localhost/index.html`
 * on Android) which a BrowserRouter cannot match. This is the single predicate the
 * router configs use to pick a path-independent HashRouter — so it stays correct on
 * Android, where only `__CORTEX_MOBILE__` (not `__CORTEX_DESKTOP__`) is set.
 */
export function isNativeShell(): boolean {
  return isDesktopShell() || isMobileShell();
}
