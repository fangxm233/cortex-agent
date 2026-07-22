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
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;

      if (mode === 'css-zoom') {
        // Anchor at cursor position.
        anchorRef.current = { ox: cx, oy: cy, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, prevScale: zoomRef.current.scale };
      }

      setZoom((prev) => {
        const dir = e.deltaY < 0 ? 1 : -1;
        const factor = 1 + dir * 0.12;
        const nextScale = clamp(prev.scale * factor);
        if (mode === 'css-zoom') return { ...prev, scale: nextScale };
        // Zoom toward cursor (transform mode).
        const ratio = nextScale / prev.scale;
        const nx = cx - ratio * (cx - prev.x);
        const ny = cy - ratio * (cy - prev.y);
        if (nextScale <= 1) return { scale: 1, x: 0, y: 0 };
        return { scale: nextScale, x: nx, y: ny };
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
        touchState.current = {
          initialDist: dist,
          initialScale: cur.scale,
          initialMid: mid,
          initialTranslate: { x: cur.x, y: cur.y },
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
          const rect = el.getBoundingClientRect();
          const cx = touchState.current!.initialMid.x - rect.left;
          const cy = touchState.current!.initialMid.y - rect.top;
          const scaleRatio = nextScale / touchState.current!.initialScale;
          const nx = cx - scaleRatio * (cx - touchState.current!.initialTranslate.x)
            + (mid.x - touchState.current!.initialMid.x);
          const ny = cy - scaleRatio * (cy - touchState.current!.initialTranslate.y)
            + (mid.y - touchState.current!.initialMid.y);
          setZoom(nextScale <= 1 ? { scale: 1, x: 0, y: 0 } : { scale: nextScale, x: nx, y: ny });
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
            const cx = e.touches[0].clientX - rect.left;
            const cy = e.touches[0].clientY - rect.top;
            const s = 2;
            setZoom({ scale: s, x: cx - s * cx, y: cy - s * cy });
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
    zoom,
    style,
    zoomIn,
    zoomOut,
    resetZoom,
    isZoomed: zoom.scale > 1,
  };
}
