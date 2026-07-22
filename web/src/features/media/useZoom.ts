import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Pinch-to-zoom + wheel zoom + pan hook for image/PDF viewers.
 *
 * Two modes:
 * - 'transform': manages scale + translate via CSS transform (for images in a fixed container).
 * - 'css-zoom': applies CSS transform: scale() only; assumes a parent scroll container handles panning.
 *   In css-zoom mode the hook auto-adjusts scroll position so the zoom anchor (cursor / pinch midpoint /
 *   viewport center) stays fixed on screen.
 */

export interface UseZoomOptions {
  minScale?: number;
  maxScale?: number;
  /** 'transform' = full pan+zoom via transform (images). 'css-zoom' = scale only (PDF in scroll container). */
  mode?: 'transform' | 'css-zoom';
}

export interface ZoomState {
  scale: number;
  x: number;
  y: number;
}

export interface UseZoomReturn {
  /** Attach to the zoomable element. */
  containerRef: (el: HTMLDivElement | null) => void;
  /** (transform mode) Attach to the transformed content element so cursor-anchored zoom can
   * measure its on-screen top-left. Optional — omit for css-zoom. */
  contentRef: (el: HTMLElement | null) => void;
  /** Current zoom state. */
  zoom: ZoomState;
  /** CSS transform + touchAction to apply. */
  style: React.CSSProperties;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
  /** Whether currently zoomed beyond 1x. */
  isZoomed: boolean;
}

const ZOOM_STEP = 0.4;

/** Whether a wheel event should zoom (vs. let the scroll container scroll).
 * - 'css-zoom' (PDF in a scroll container): scroll on a plain wheel, zoom ONLY while Ctrl/⌘ is held.
 *   (Trackpad pinch is delivered by the browser as a ctrl+wheel event, so it still zooms.)
 * - 'transform' (image lightbox, no scroll container): the wheel always zooms. */
export function wheelShouldZoom(
  mode: 'transform' | 'css-zoom',
  modifier: { ctrlKey: boolean; metaKey: boolean },
): boolean {
  if (mode === 'transform') return true;
  return modifier.ctrlKey || modifier.metaKey;
}

/** Transform-mode anchored zoom (wheel / double-tap): return the next zoom state so the content
 * point currently under `anchor` (the cursor) stays fixed on screen across the scale change.
 *
 * With `transform-origin: 0 0`, a content-local point `p` (unscaled px from the content top-left)
 * projects to `contentTopLeft + scale * p`. `contentTopLeft` is the content element's CURRENT
 * on-screen top-left from getBoundingClientRect() — measured on the transformed content itself,
 * NOT the container. The content is centered in the container, so using the container corner would
 * anchor the zoom off by the centering offset (the "zoom not centered on cursor" bug). */
export function anchoredZoom(
  prev: ZoomState,
  nextScale: number,
  anchor: { x: number; y: number },
  contentTopLeft: { x: number; y: number },
): ZoomState {
  if (nextScale <= 1) return { scale: 1, x: 0, y: 0 };
  const ratio = nextScale / prev.scale;
  // Keep (anchor - contentTopLeft) fixed: translate += (1 - ratio) * (anchor - contentTopLeft).
  return {
    scale: nextScale,
    x: prev.x + (1 - ratio) * (anchor.x - contentTopLeft.x),
    y: prev.y + (1 - ratio) * (anchor.y - contentTopLeft.y),
  };
}

/** Transform-mode two-finger pinch: return the next zoom state so the content point under the
 * pinch midpoint stays under it while the fingers scale/move. `startTopLeft` is the content
 * element's on-screen top-left captured at gesture start (getBoundingClientRect, transform-origin
 * 0 0) — again the content's own box, not the container's. */
export function anchoredPinch(
  initialScale: number,
  initialTranslate: { x: number; y: number },
  initialMid: { x: number; y: number },
  currentMid: { x: number; y: number },
  nextScale: number,
  startTopLeft: { x: number; y: number },
): ZoomState {
  if (nextScale <= 1) return { scale: 1, x: 0, y: 0 };
  const scaleRatio = nextScale / initialScale;
  return {
    scale: nextScale,
    x: initialTranslate.x + (currentMid.x - initialMid.x) + (initialMid.x - startTopLeft.x) * (1 - scaleRatio),
    y: initialTranslate.y + (currentMid.y - initialMid.y) + (initialMid.y - startTopLeft.y) * (1 - scaleRatio),
  };
}

/** Saved before each css-zoom scale change so the layoutEffect can reposition scroll. */
interface ScrollAnchor {
  /** Anchor X offset from scroll container viewport left. */
  ox: number;
  /** Anchor Y offset from scroll container viewport top. */
  oy: number;
  scrollLeft: number;
  scrollTop: number;
  prevScale: number;
}

export function useZoom(opts: UseZoomOptions = {}): UseZoomReturn {
  const { minScale = 1, maxScale = 5, mode = 'transform' } = opts;
  const [zoom, setZoom] = useState<ZoomState>({ scale: 1, x: 0, y: 0 });
  // Store element in state so the effect re-runs when the element mounts/unmounts
  // (fixes the case where the zoomable element renders conditionally after async load).
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  // The transformed content element (transform mode) — read live inside handlers via a ref so
  // it never re-attaches listeners. Used to measure the content's on-screen top-left for
  // cursor-anchored zoom (see anchoredZoom).
  const contentElRef = useRef<HTMLElement | null>(null);
  // Keep latest zoom in a ref so event handlers always see current values without
  // the effect re-running (which would re-attach listeners on every frame).
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;

  // Scroll anchor — set before each css-zoom scale change, consumed in useLayoutEffect.
  const anchorRef = useRef<ScrollAnchor | null>(null);

  // Touch state refs (not reactive — used only in event handlers).
  const touchState = useRef<{
    initialDist: number;
    initialScale: number;
    initialMid: { x: number; y: number };
    initialTranslate: { x: number; y: number };
    /** (transform mode) content on-screen top-left at gesture start, for anchoredPinch. */
    startTopLeft: { x: number; y: number };
  } | null>(null);

  // Pan state refs (pointer drag when zoomed).
  const panState = useRef<{
    startX: number;
    startY: number;
    startTranslateX: number;
    startTranslateY: number;
  } | null>(null);

  const clamp = useCallback((s: number) => Math.min(maxScale, Math.max(minScale, s)), [minScale, maxScale]);

  /** Save a scroll anchor at viewport center (used by button zoom). */
  const saveViewportAnchor = useCallback(() => {
    if (!el || mode !== 'css-zoom') return;
    anchorRef.current = {
      ox: el.clientWidth / 2,
      oy: el.clientHeight / 2,
      scrollLeft: el.scrollLeft,
      scrollTop: el.scrollTop,
      prevScale: zoomRef.current.scale,
    };
  }, [el, mode]);

  const zoomIn = useCallback(() => {
    saveViewportAnchor();
    setZoom((prev) => ({ ...prev, scale: Math.min(maxScale, prev.scale + ZOOM_STEP) }));
  }, [maxScale, saveViewportAnchor]);

  const zoomOut = useCallback(() => {
    saveViewportAnchor();
    setZoom((prev) => {
      const next = Math.max(minScale, prev.scale - ZOOM_STEP);
      if (next <= 1) return { scale: 1, x: 0, y: 0 };
      return { ...prev, scale: next };
    });
  }, [minScale, saveViewportAnchor]);

  const resetZoom = useCallback(() => {
    saveViewportAnchor();
    setZoom({ scale: 1, x: 0, y: 0 });
  }, [saveViewportAnchor]);

  const containerRef = useCallback((node: HTMLDivElement | null) => { setEl(node); }, []);
  const contentRef = useCallback((node: HTMLElement | null) => { contentElRef.current = node; }, []);

  // --- css-zoom scroll correction: runs before paint so there's no flash. ---
  useLayoutEffect(() => {
    if (!el || mode !== 'css-zoom' || !anchorRef.current) return;
    const { ox, oy, scrollLeft: oldSL, scrollTop: oldST, prevScale } = anchorRef.current;
    const newScale = zoom.scale;
    anchorRef.current = null;
    if (prevScale === newScale) return;
    // The anchor point in unscaled content: (oldSL + ox) / prevScale.
    // At the new scale that becomes (oldSL + ox) / prevScale * newScale.
    // We want it at the same viewport offset (ox, oy), so:
    const ratio = newScale / prevScale;
    el.scrollLeft = (oldSL + ox) * ratio - ox;
    el.scrollTop = (oldST + oy) * ratio - oy;
  }, [zoom.scale, el, mode]);

  useEffect(() => {
    if (!el) return;

    // --- Wheel zoom (desktop) ---
    const onWheel = (e: WheelEvent): void => {
      // In css-zoom mode the wheel scrolls the container; only Ctrl/⌘+wheel zooms.
      // Bail out (no preventDefault) so the native scroll runs normally.
      if (!wheelShouldZoom(mode, e)) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();

      if (mode === 'css-zoom') {
        // Anchor at cursor position; scroll correction happens in the layoutEffect.
        anchorRef.current = { ox: e.clientX - rect.left, oy: e.clientY - rect.top, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, prevScale: zoomRef.current.scale };
        setZoom((prev) => {
          const dir = e.deltaY < 0 ? 1 : -1;
          const factor = 1 + dir * 0.12;
          return { ...prev, scale: clamp(prev.scale * factor) };
        });
        return;
      }

      // Transform mode: anchor the zoom on the cursor. Measure the *content* element's current
      // on-screen top-left (its transform origin) — the content is centered in the container, so a
      // container-relative anchor is off by the centering offset (the "zoom not centered" bug).
      const contentRect = contentElRef.current?.getBoundingClientRect();
      const origin = { x: contentRect?.left ?? rect.left, y: contentRect?.top ?? rect.top };
      setZoom((prev) => {
        const dir = e.deltaY < 0 ? 1 : -1;
        const factor = 1 + dir * 0.12;
        const nextScale = clamp(prev.scale * factor);
        return anchoredZoom(prev, nextScale, { x: e.clientX, y: e.clientY }, origin);
      });
    };

    // --- Pinch-to-zoom (mobile) ---
    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches.length === 2) {
        e.preventDefault();
        const [a, b] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
        const cur = zoomRef.current;
        const r0 = contentElRef.current?.getBoundingClientRect();
        touchState.current = {
          initialDist: dist,
          initialScale: cur.scale,
          initialMid: mid,
          initialTranslate: { x: cur.x, y: cur.y },
          startTopLeft: { x: r0?.left ?? 0, y: r0?.top ?? 0 },
        };
      }
    };

    const onTouchMove = (e: TouchEvent): void => {
      if (e.touches.length === 2 && touchState.current) {
        e.preventDefault();
        const [a, b] = [e.touches[0], e.touches[1]];
        const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
        const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
        const ratio = dist / touchState.current.initialDist;
        const nextScale = clamp(touchState.current.initialScale * ratio);

        if (mode === 'css-zoom') {
          // Anchor at pinch midpoint.
          const rect = el.getBoundingClientRect();
          anchorRef.current = { ox: mid.x - rect.left, oy: mid.y - rect.top, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, prevScale: zoomRef.current.scale };
          setZoom((prev) => ({ ...prev, scale: nextScale }));
        } else {
          const ts = touchState.current!;
          setZoom(anchoredPinch(ts.initialScale, ts.initialTranslate, ts.initialMid, mid, nextScale, ts.startTopLeft));
        }
      }
    };

    const onTouchEnd = (e: TouchEvent): void => {
      if (e.touches.length < 2) touchState.current = null;
    };

    // --- Double-tap to toggle zoom (mobile) ---
    let lastTap = 0;
    const onDoubleTap = (e: TouchEvent): void => {
      if (e.touches.length !== 1) return;
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        const cur = zoomRef.current;
        if (cur.scale > 1) {
          if (mode === 'css-zoom') {
            anchorRef.current = { ox: el.clientWidth / 2, oy: el.clientHeight / 2, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, prevScale: cur.scale };
          }
          setZoom({ scale: 1, x: 0, y: 0 });
        } else {
          if (mode === 'css-zoom') {
            const rect = el.getBoundingClientRect();
            anchorRef.current = { ox: e.touches[0].clientX - rect.left, oy: e.touches[0].clientY - rect.top, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, prevScale: cur.scale };
            setZoom({ scale: 2, x: 0, y: 0 });
          } else {
            const rect = el.getBoundingClientRect();
            const contentRect = contentElRef.current?.getBoundingClientRect();
            const origin = { x: contentRect?.left ?? rect.left, y: contentRect?.top ?? rect.top };
            setZoom(anchoredZoom({ scale: 1, x: 0, y: 0 }, 2, { x: e.touches[0].clientX, y: e.touches[0].clientY }, origin));
          }
        }
      }
      lastTap = now;
    };

    // --- Single-finger pan when zoomed (transform mode only) ---
    const onPanStart = (e: TouchEvent): void => {
      if (mode !== 'transform' || e.touches.length !== 1) return;
      const cur = zoomRef.current;
      if (cur.scale <= 1) return;
      panState.current = {
        startX: e.touches[0].clientX,
        startY: e.touches[0].clientY,
        startTranslateX: cur.x,
        startTranslateY: cur.y,
      };
    };

    const onPanMove = (e: TouchEvent): void => {
      if (!panState.current || e.touches.length !== 1) return;
      e.preventDefault();
      const dx = e.touches[0].clientX - panState.current.startX;
      const dy = e.touches[0].clientY - panState.current.startY;
      setZoom((prev) => ({
        ...prev,
        x: panState.current!.startTranslateX + dx,
        y: panState.current!.startTranslateY + dy,
      }));
    };

    const onPanEnd = (): void => { panState.current = null; };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: false });
    el.addEventListener('touchstart', onDoubleTap, { passive: false });
    el.addEventListener('touchstart', onPanStart, { passive: false });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchmove', onPanMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd);
    el.addEventListener('touchend', onPanEnd);

    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchstart', onDoubleTap);
      el.removeEventListener('touchstart', onPanStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchmove', onPanMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchend', onPanEnd);
    };
  }, [el, clamp, mode]);

  const style: React.CSSProperties =
    mode === 'transform'
      ? { transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`, transformOrigin: '0 0', touchAction: 'none' }
      : { transform: `scale(${zoom.scale})`, transformOrigin: 'top left' };

  return {
    containerRef,
    contentRef,
    zoom,
    style,
    zoomIn,
    zoomOut,
    resetZoom,
    isZoomed: zoom.scale > 1,
  };
}
