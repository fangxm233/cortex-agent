import { useEffect, useState } from 'react';

/** A press that moves less than this is still a click, not a drag. */
const CLICK_SLOP_PX = 4;

interface Drag {
  startX: number;
  startY: number;
  tx: number;
  ty: number;
  moved: boolean;
}

/** The zoom state a pan reads (structurally useZoom's ZoomState; not imported, to avoid a cycle). */
export interface PanZoom {
  scale: number;
  x: number;
  y: number;
}

export interface MousePanDeps {
  getZoom: () => PanZoom;
  /** Whether a pannable image is mounted (a video in the same stage must keep its own mouse input). */
  hasContent: () => boolean;
  setTranslate: (t: { x: number; y: number }) => void;
  onDragChange: (dragging: boolean) => void;
}

/** Swallow the click that ends a drag: releasing over the scrim would otherwise count as a click on it
 * (the lightbox resets zoom on a scrim click). Dropped on the next task if no click follows. */
function suppressNextClick(): void {
  const stop = (e: Event): void => { e.stopPropagation(); e.preventDefault(); };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

/** Follow the cursor 1:1 from the drag start; past the click slop the press counts as a drag. */
function dragTo(drag: Drag, e: MouseEvent): { x: number; y: number } {
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (Math.hypot(dx, dy) > CLICK_SLOP_PX) drag.moved = true;
  return { x: drag.tx + dx, y: drag.ty + dy };
}

/** Left-button drag on `el` pans the zoomed content 1:1 with the cursor. Move/up listen on `window`
 * so the drag keeps tracking once the cursor leaves the stage. Returns the unbind function. */
export function bindMousePan(el: EventTarget, deps: MousePanDeps): () => void {
  let drag: Drag | null = null;

  const onMove = (e: MouseEvent): void => { if (drag) deps.setTranslate(dragTo(drag, e)); };
  const end = (): boolean => {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    const moved = drag?.moved ?? false;
    if (drag) deps.onDragChange(false);
    drag = null;
    return moved;
  };
  function onUp(): void {
    if (end()) suppressNextClick();
  }
  const onDown = (e: MouseEvent): void => {
    const cur = deps.getZoom();
    if (e.button !== 0 || cur.scale <= 1 || !deps.hasContent()) return;
    e.preventDefault();
    drag = { startX: e.clientX, startY: e.clientY, tx: cur.x, ty: cur.y, moved: false };
    deps.onDragChange(true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  el.addEventListener('mousedown', onDown as EventListener);
  return () => { el.removeEventListener('mousedown', onDown as EventListener); end(); };
}

/** Desktop mouse drag-to-pan for transform-mode zoom. Returns whether a drag is in progress. */
export function useMousePan(
  el: HTMLElement | null,
  enabled: boolean,
  deps: Pick<MousePanDeps, 'getZoom' | 'hasContent' | 'setTranslate'>,
): boolean {
  const [dragging, setDragging] = useState(false);
  const { getZoom, hasContent, setTranslate } = deps;
  useEffect(() => {
    if (!el || !enabled) return;
    return bindMousePan(el, { getZoom, hasContent, setTranslate, onDragChange: setDragging });
  }, [el, enabled, getZoom, hasContent, setTranslate]);
  return dragging;
}
