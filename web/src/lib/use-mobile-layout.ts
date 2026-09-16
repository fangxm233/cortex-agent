// input:  native shell flags (desktop-config) + the browser viewport media query
// output: useMobileLayout() — true when the mobile layout should render
// pos:    The single source of truth for the mobile/desktop LAYOUT switch. Native mobile is always
//         mobile, native desktop is always desktop, and an ordinary browser follows the viewport
//         (≤ MOBILE_MAX_WIDTH). Language is never consulted here — the language is a separate,
//         server-owned knob (i18n/lang.ts); this hook only describes the layout.

import { useSyncExternalStore } from 'react';
import { MOBILE_MAX_WIDTH } from '@/i18n/lang';
import { isDesktopShell, isMobileShell } from './desktop-config';

/** The viewport media query separating the mobile layout from the desktop one. */
export const MOBILE_LAYOUT_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

// Cache the MediaQueryList per `window` object. Tests swap `globalThis.window` between cases, so
// keying the cache on the window (rather than on the module) means a fresh window gets a fresh
// query and a fresh listener set instead of a stale one from a previous case.
let cachedWindow: unknown = null;
let cachedQuery: MediaQueryList | null = null;

function viewportQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (cachedWindow !== window) {
    cachedWindow = window;
    try {
      cachedQuery = window.matchMedia(MOBILE_LAYOUT_QUERY);
    } catch {
      cachedQuery = null;
    }
  }
  return cachedQuery;
}

/** Synchronous viewport read. No `matchMedia` (node, tests, old webviews) → desktop. */
function viewportSnapshot(): boolean {
  return viewportQuery()?.matches ?? false;
}

/** Deterministic desktop fallback for server/no-DOM rendering. */
function viewportServerSnapshot(): boolean {
  return false;
}

function subscribeViewport(onChange: () => void): () => void {
  const query = viewportQuery();
  if (!query) return () => {};
  if (typeof query.addEventListener === 'function') {
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }
  // Legacy MediaQueryList (older WebKit) only exposes addListener/removeListener.
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

/**
 * True when the mobile layout should render:
 *
 *   - native mobile shell (`__CORTEX_MOBILE__`)  → always true,
 *   - native desktop shell (`__CORTEX_DESKTOP__`) → always false,
 *   - ordinary browser → `(max-width: 767px)`, read synchronously on the first render and
 *     re-read reactively whenever the viewport crosses the breakpoint,
 *   - no `window` / no `matchMedia` → desktop (false).
 *
 * The native flags keep their existing meaning (see `desktop-config.ts`); a narrow browser window
 * is mobile for LAYOUT without becoming a native shell. The result is independent of the active
 * language.
 */
export function useMobileLayout(): boolean {
  const viewport = useSyncExternalStore(subscribeViewport, viewportSnapshot, viewportServerSnapshot);
  if (isMobileShell()) return true;
  if (isDesktopShell()) return false;
  return viewport;
}
