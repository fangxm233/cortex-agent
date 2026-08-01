// input:  shell config, tRPC/query clients, theme, language, overlays
// output: global application provider stack including LoginFlow
// pos:    Root dependency and cross-surface provider composition
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { TRPCProvider, createTrpcClient } from '@/lib/trpc';
import { readDesktopConfig, isNativeShell } from '@/lib/desktop-config';
import { TooltipProvider, ToastProvider } from '@/design';
import { LangProvider } from '@/i18n';
import { ThemeProvider } from '@/theme';
import { LoginFlowProvider } from '@/features/auth/LoginFlowProvider';

// How long the native shell will wait for its injected credentials before giving up and falling
// back to browser mode. The Tauri shell now BAKES the credentials into the initialization_script
// synchronously (see desktop/src-tauri/src/lib.rs `init_script`), so on a normal launch the config
// is already present at first render and this timeout never fires. It only covers the first-run
// connect flow, where the window was built before the user saved credentials and the value arrives
// a moment later via the async `get_connection_config` IPC refresh.
const CONFIG_WAIT_MS = 2000;
const CONFIG_POLL_MS = 20;

/**
 * Resolve the desktop/mobile shell credentials, tolerating the async IPC refresh path.
 *
 * Reads the (usually baked-in, synchronous) `window.__CORTEX_DESKTOP_CONFIG` immediately. If we are
 * inside a native shell but the config is not yet present (first-run connect flow, where it arrives
 * shortly via IPC), it polls briefly until the value shows up or a short deadline passes — then
 * reports `done` so rendering can proceed. In browser / ui-http mode there is nothing to wait for,
 * so it is `done` immediately with no config (same-origin relative-/trpc mode).
 *
 * This removes the old "read the config exactly once at mount" race: the tRPC client is never built
 * from a not-yet-injected config, so the SPA can't end up with a dead client while the shell chrome
 * (e.g. the mobile bottom Tab bar) still renders.
 */
function useShellConfig(): { config: ReturnType<typeof readDesktopConfig>; done: boolean } {
  const [state, setState] = useState(() => {
    const config = readDesktopConfig();
    // Browser mode has no injected config to await; native shell with a config already present
    // (baked-in, the common case) is likewise done immediately.
    return { config, done: !!config || !isNativeShell() };
  });

  useEffect(() => {
    if (state.done) return;
    let cancelled = false;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const config = readDesktopConfig();
      if (config) {
        if (!cancelled) setState({ config, done: true });
        clearInterval(timer);
      } else if (Date.now() - startedAt >= CONFIG_WAIT_MS) {
        // Give up waiting — fall back to browser mode (a stale/dead client the user can still
        // recover from via the connect flow), rather than hanging on a blank screen forever.
        if (!cancelled) setState({ config: undefined, done: true });
        clearInterval(timer);
      }
    }, CONFIG_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state.done]);

  return state;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  // In desktop / mobile shell mode the Tauri shell injects {serverUrl, token} via
  // window.__CORTEX_DESKTOP_CONFIG (baked into the init script synchronously, with an async IPC
  // refresh as a fallback); useShellConfig picks it up and switches tRPC to absolute-URL +
  // token-bearer mode. Building the client from the resolved config avoids the second-launch race
  // where a code-cached bundle mounted React before the credentials were available.
  const { config, done } = useShellConfig();
  const trpcClient = useMemo(() => createTrpcClient(config), [config]);

  // Native shell still awaiting its injected credentials — hold rendering for the brief window
  // rather than mounting a broken client. Not reached in browser mode (done synchronously).
  if (!done) return null;

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <ThemeProvider>
          <TooltipProvider>
            <ToastProvider>
              <LangProvider><LoginFlowProvider>{children}</LoginFlowProvider></LangProvider>
            </ToastProvider>
          </TooltipProvider>
        </ThemeProvider>
      </TRPCProvider>
    </QueryClientProvider>
  );
}
