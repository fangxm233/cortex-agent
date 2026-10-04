import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type MutableRefObject, type ReactNode, type RefObject } from 'react';
import { MC } from '@/mobile/ui/kit';
import {
  drawerProgress,
  lockDrawerPan,
  panVelocity,
  settleDrawer,
  trimSamples,
  type DrawerLock,
  type PanSample,
} from './m-drawer-gesture';

// The home's left panel (Projects). It tracks the finger while dragged and settles open or closed;
// pans are read off native listeners and painted straight onto the panel and scrim (transform and
// opacity only), so a drag never re-renders the list or the panel contents. Reduced motion is the
// global transition policy in index.css.

const DRAWER_MS = 280;
const DRAWER_EASE = 'cubic-bezier(.32,.72,0,1)';
const SCRIM_OPACITY = 0.38;
/** A click right after a drag is the drag's own release, not a tap. */
const CLICK_AFTER_PAN_MS = 350;
const FIELD_SELECTOR = 'input, textarea, select, [contenteditable="true"]';

interface Pan {
  id: number;
  x0: number;
  y0: number;
  startedOpen: boolean;
  lock: DrawerLock;
  width: number;
  progress: number;
  samples: PanSample[];
}

interface DrawerParts {
  panel: RefObject<HTMLDivElement>;
  scrim: RefObject<HTMLDivElement>;
}

function paintDrawer({ panel, scrim }: DrawerParts, progress: number, animate: boolean): void {
  const panelEl = panel.current;
  const scrimEl = scrim.current;
  if (!panelEl || !scrimEl) return;
  const shown = progress > 0;
  // Hidden only once the close has finished, so the panel slides out instead of vanishing.
  const visibility = `visibility 0s linear ${shown ? 0 : DRAWER_MS}ms`;
  panelEl.style.transition = animate ? `transform ${DRAWER_MS}ms ${DRAWER_EASE}, ${visibility}` : 'none';
  panelEl.style.transform = `translate3d(${(progress - 1) * 100}%, 0, 0)`;
  panelEl.style.visibility = shown ? 'visible' : 'hidden';
  scrimEl.style.transition = animate ? `opacity ${DRAWER_MS}ms ${DRAWER_EASE}, ${visibility}` : 'none';
  scrimEl.style.opacity = String(progress * SCRIM_OPACITY);
  scrimEl.style.visibility = shown ? 'visible' : 'hidden';
  scrimEl.style.pointerEvents = progress === 1 ? 'auto' : 'none';
}

function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function useDrawerPan(
  host: RefObject<HTMLDivElement>,
  parts: DrawerParts,
  open: MutableRefObject<boolean>,
  onOpenChange: MutableRefObject<(open: boolean) => void>,
): void {
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let pan: Pan | null = null;
    let frame = 0;
    let swallowClicksUntil = 0;
    const paintSoon = (progress: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => paintDrawer(parts, progress, false));
    };
    const onDown = (event: PointerEvent) => {
      // A new primary pointer starts a new gesture, so it also clears any pan whose end went missing.
      if (!event.isPrimary || event.button !== 0) return;
      pan = null;
      // A drag inside a text field selects text.
      if (event.target instanceof Element && event.target.closest(FIELD_SELECTOR)) return;
      const startedOpen = open.current;
      pan = {
        id: event.pointerId, x0: event.clientX, y0: event.clientY, startedOpen, lock: 'pending',
        width: parts.panel.current?.offsetWidth ?? 0, progress: startedOpen ? 1 : 0,
        samples: [{ x: event.clientX, t: event.timeStamp }],
      };
    };
    const onMove = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.id) return;
      const dx = event.clientX - pan.x0;
      if (pan.lock === 'pending') {
        pan.lock = lockDrawerPan(dx, event.clientY - pan.y0, pan.startedOpen);
        if (pan.lock === 'drawer') el.setPointerCapture?.(event.pointerId);
      }
      if (pan.lock !== 'drawer') return;
      pan.samples = trimSamples([...pan.samples, { x: event.clientX, t: event.timeStamp }], event.timeStamp);
      pan.progress = drawerProgress(dx, pan.width, pan.startedOpen);
      paintSoon(pan.progress);
    };
    const onUp = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.id) return;
      const done = pan;
      pan = null;
      if (done.lock !== 'drawer') return;
      cancelAnimationFrame(frame);
      swallowClicksUntil = event.timeStamp + CLICK_AFTER_PAN_MS;
      const samples = trimSamples([...done.samples, { x: event.clientX, t: event.timeStamp }], event.timeStamp);
      const next = settleDrawer(done.progress, panVelocity(samples), done.startedOpen);
      // Settle from where the finger left it now; the route change that follows paints the same target.
      paintDrawer(parts, next ? 1 : 0, true);
      if (next !== open.current) onOpenChange.current(next);
    };
    const onCancel = (event: PointerEvent) => {
      if (!pan || event.pointerId !== pan.id) return;
      const done = pan;
      pan = null;
      cancelAnimationFrame(frame);
      if (done.lock === 'drawer') paintDrawer(parts, done.startedOpen ? 1 : 0, true);
    };
    const onClickCapture = (event: MouseEvent) => {
      if (event.timeStamp > swallowClicksUntil) return;
      event.stopPropagation();
      event.preventDefault();
    };
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('click', onClickCapture, true);
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('click', onClickCapture, true);
    };
  }, [host, parts, open, onOpenChange]);
}

// Focus follows the panel: into it on open, out of it on close, so keyboard and screen-reader
// users are never left on content hidden behind the scrim.
function useDrawerFocus(open: boolean, panel: RefObject<HTMLDivElement>): void {
  const previous = useRef(open);
  useEffect(() => {
    const el = panel.current;
    if (!el || previous.current === open) return;
    previous.current = open;
    const active = document.activeElement;
    if (open && !el.contains(active)) el.focus({ preventScroll: true });
    if (!open && active instanceof HTMLElement && el.contains(active)) active.blur();
  }, [open, panel]);
}

const HOST_STYLE: CSSProperties = { position: 'relative', height: '100%', overflow: 'hidden' };

const SCRIM_STYLE: CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 8, background: 'var(--overlay-ink)',
  opacity: 0, visibility: 'hidden', pointerEvents: 'none', willChange: 'opacity',
};

const PANEL_STYLE: CSSProperties = {
  position: 'absolute', top: 0, bottom: 0, left: 0, zIndex: 9,
  // A strip of the list stays visible beside the open panel: the scrim there closes it.
  width: 'min(calc(100% - 56px), 420px)',
  background: MC.backdrop, boxShadow: 'var(--material-overlay-shadow)', outline: 'none',
  transform: 'translate3d(-100%, 0, 0)', visibility: 'hidden', willChange: 'transform',
};

export function MHomeDrawer({ open, onOpenChange, panelLabel, panel, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Accessible name of the panel. */
  panelLabel: string;
  panel: ReactNode;
  children: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const parts = useMemo<DrawerParts>(() => ({ panel: panelRef, scrim: scrimRef }), []);
  const openRef = useLatest(open);
  const changeRef = useLatest(onOpenChange);
  const painted = useRef(false);
  useLayoutEffect(() => {
    // A deep link lands with the panel already open; only later changes slide.
    paintDrawer(parts, open ? 1 : 0, painted.current);
    painted.current = true;
  }, [open, parts]);
  useDrawerFocus(open, panelRef);
  useDrawerPan(host, parts, openRef, changeRef);
  return (
    <div ref={host} data-m-drawer-host="" style={HOST_STYLE}>
      <div style={{ height: '100%' }}>{children}</div>
      <div ref={scrimRef} data-m-drawer-scrim="" style={SCRIM_STYLE} onClick={() => onOpenChange(false)} />
      <div ref={panelRef} data-m-drawer-panel="" data-open={open ? 'true' : 'false'} role="dialog"
        aria-modal="true" aria-label={panelLabel} tabIndex={-1} style={PANEL_STYLE}>
        {panel}
      </div>
    </div>
  );
}
