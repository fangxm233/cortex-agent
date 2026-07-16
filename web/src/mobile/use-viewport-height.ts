// Keyboard-aware viewport height for the mobile shell.
//
// Problem: when the soft keyboard opens, the default mobile/WebView behaviour is to PAN the whole
// page up (or leave `100dvh` unchanged), so the fixed-height shell scrolls its top off-screen to keep
// the focused input visible — the top chrome disappears and the entire UI appears to shift up.
//
// Fix: drive the shell height from `window.visualViewport` instead of `100dvh`. The visual viewport
// shrinks to the area NOT covered by the keyboard, so pinning the shell to it keeps the top fixed,
// shrinks the middle scroll area (a `flex:1` child), and lets the bottom composer (`flex:none`) rise
// to sit right above the keyboard. `offsetTop` compensates for any residual browser pan so the shell
// stays glued to the visible region.
//
// We publish the measured values as CSS variables on <html> (`--cortex-vvh` / `--cortex-vvt`) rather
// than React state, so the per-frame keyboard animation never triggers a React re-render. The shell
// reads them via `height: var(--cortex-vvh, 100dvh)` + `translateY(var(--cortex-vvt, 0px))`, falling
// back to `100dvh` / `0px` before the first measurement (and on browsers without visualViewport).
import { useEffect } from 'react';

export const VVH_VAR = '--cortex-vvh';
export const VVT_VAR = '--cortex-vvt';

// Minimal structural surfaces so the core is testable without a DOM (tests here run in node).
interface CssVarTarget {
  setProperty(name: string, value: string): void;
  removeProperty(name: string): void;
}
interface ViewportLike {
  height: number;
  offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', fn: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', fn: () => void): void;
}

/**
 * Mirror `viewport` height/offset into the CSS variables on `target`, keeping them in sync on
 * resize/scroll. Returns a cleanup that detaches the listeners and clears the variables. Pure w.r.t.
 * the injected surfaces — no direct `window`/`document` access — so it is unit-testable in node.
 */
export function attachViewportHeight(target: CssVarTarget, viewport: ViewportLike): () => void {
  const apply = (): void => {
    target.setProperty(VVH_VAR, `${viewport.height}px`);
    target.setProperty(VVT_VAR, `${viewport.offsetTop}px`);
  };
  apply();
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
    target.removeProperty(VVH_VAR);
    target.removeProperty(VVT_VAR);
  };
}

/**
 * Track the visual viewport and mirror it into the `--cortex-vvh` / `--cortex-vvt` CSS variables on
 * the document root. Mount this once (in the shell). No-op with a graceful fallback when
 * `window.visualViewport` is unavailable.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    return attachViewportHeight(document.documentElement.style, vv);
  }, []);
}
