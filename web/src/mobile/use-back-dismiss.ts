// input:  browser history, overlay dismiss callback, and optional nested-level reset key
// output: sentinel-aware hardware-back dismissal hook that can re-arm after level changes
// pos:    Mobile transient-overlay history guard
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<
import { useEffect, useRef } from 'react';

// ── Android / browser back → dismiss a transient overlay (not navigate the router) ────────────────
//
// In the Tauri v2 Android shell the hardware back button is forwarded to the WebView as a history
// "back" navigation (a popstate). Because the mobile SPA is a HashRouter with real history entries,
// a back press pops a ROUTE (e.g. chat → session list) — which is wrong while a transient overlay
// (bottom sheet / menu / modal) is open: the user expects back to close the overlay first.
//
// Fix: while the overlay is open we push a throwaway "sentinel" history entry. A back press then pops
// the sentinel (not a route); we intercept that popstate and run the overlay's dismiss instead. The
// route never changes. If the overlay is closed by any OTHER means (tap-away, pick, drag-fling), we
// pop the sentinel ourselves so the history stack stays balanced and the next back isn't wasted.

export interface BackGuardHost {
  /** Push the throwaway sentinel history entry (URL/hash unchanged). */
  pushSentinel(): void;
  /** Remove the sentinel we pushed (a programmatic back). */
  popSentinel(): void;
  /** Whether the current entry is still the sentinel this guard owns. */
  isSentinelActive(): boolean;
  addPopListener(fn: () => void): void;
  removePopListener(fn: () => void): void;
}

/**
 * Pure guard controller (no React, no `window`) so the history-balancing contract is unit-testable.
 * Arms immediately and returns a teardown fn to call when the overlay unmounts.
 */
export function armBackGuard(host: BackGuardHost, onDismiss: () => void): () => void {
  let dismissedByBack = false;
  const onPop = (): void => {
    if (dismissedByBack) return; // a stray/duplicate popstate must not fire a real navigation
    dismissedByBack = true;
    onDismiss();
  };
  host.pushSentinel();
  host.addPopListener(onPop);
  return () => {
    host.removePopListener(onPop);
    // Tap-away / pick / drag leaves the sentinel current, so remove it. Route actions replace the
    // sentinel before teardown; never back over that destination. A hardware back already popped it.
    if (!dismissedByBack && host.isSentinelActive()) host.popSentinel();
  };
}

function windowBackGuardHost(): BackGuardHost {
  return {
    pushSentinel: () => {
      // Spread react-router's history state (usr/key/idx) onto the sentinel so its internal index
      // bookkeeping survives the push-then-back round-trip; omit the URL so the hash stays put.
      window.history.pushState({ ...(window.history.state as object | null), __cortexOverlay: true }, '');
    },
    popSentinel: () => window.history.back(),
    isSentinelActive: () => window.history.state?.__cortexOverlay === true,
    addPopListener: (fn) => window.addEventListener('popstate', fn),
    removePopListener: (fn) => window.removeEventListener('popstate', fn),
  };
}

/**
 * Mount this from an overlay component (which the parent renders only while open) to make the Android
 * hardware back button (and browser back) dismiss the overlay instead of navigating the router.
 * `onDismiss` is read through a ref so the latest closure is always used without re-arming.
 */
export function useBackDismiss(onDismiss: () => void, resetKey?: unknown): void {
  const ref = useRef(onDismiss);
  ref.current = onDismiss;
  // A nested sheet level consumes the sentinel without unmounting the sheet. Re-arm when that level
  // changes so a second hardware-back press can dismiss the next level instead of navigating away.
  useEffect(() => armBackGuard(windowBackGuardHost(), () => ref.current()), [resetKey]);
}
