// Native-shell connection lifecycle seam — "disconnect from the current server".
//
// The daemon interfaces (desktop DaemonStatusModal, mobile MDaemonView) offer a "断开连接"/Disconnect
// action that clears the saved credentials (key/token) and returns to the connect (login) screen.
// This is the SPA-side counterpart of the shell's `disconnect` Tauri command (clears the OS keychain /
// app-private store + AppState — see desktop/src-tauri/src/lib.rs) plus the navigation the injected
// "Switch" button used to own.
//
// Accessed via the global `window.__TAURI__` (the shell is built with `withGlobalTauri: true`), so no
// `@tauri-apps/api` dependency is added — mirrors `lib/files.ts` and `features/hot-update`. Off-shell
// (plain browser / ui-http) there is no native store to clear and no connect screen to return to, so
// `disconnectShell` is a no-op.
import { isNativeShell } from './desktop-config';

/**
 * The connect (login) screen the native shell serves. A RELATIVE path so it resolves against the live
 * `cortexui://localhost` origin on BOTH desktop and Android — the shell serves an embedded copy of
 * `connect.html` there (see desktop/CORTEX.md "Frontend OTA").
 */
export const CONNECT_SCREEN_PATH = 'connect.html';

interface TauriCore {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
}
function tauriCore(): TauriCore | undefined {
  return (globalThis as unknown as { __TAURI__?: { core?: TauriCore } }).__TAURI__?.core;
}

/**
 * Pure orchestration of a disconnect: clear the stored credentials via `invoke('disconnect')`, then
 * navigate back to the connect screen. It ALWAYS navigates — even if the clear throws — so a stale /
 * dead saved server is always recoverable (mirrors the old injected "Switch" button's
 * `.catch(...).finally(navigate)`). Dependencies are injected so this is unit-testable without a real
 * Tauri core or DOM.
 */
export async function runDisconnect(deps: {
  invoke?: (cmd: string) => Promise<unknown>;
  navigate: (url: string) => void;
}): Promise<void> {
  try {
    await deps.invoke?.('disconnect');
  } catch {
    // Even if clearing the credential store fails, still return to the connect screen so the user can
    // re-enter (or switch) the server — never trap them on a broken connection.
  } finally {
    deps.navigate(CONNECT_SCREEN_PATH);
  }
}

/**
 * Disconnect the native shell from its current server: clears the saved key/token and returns to the
 * connect (login) screen. Off-shell (plain browser / ui-http) it is a no-op — auth there is
 * same-origin / Cloudflare Access, with no local credentials to clear and no connect screen.
 */
export async function disconnectShell(): Promise<void> {
  if (!isNativeShell()) return;
  const core = tauriCore();
  await runDisconnect({
    invoke: core ? (cmd) => core.invoke(cmd) : undefined,
    navigate: (url) => {
      window.location.href = url;
    },
  });
}
