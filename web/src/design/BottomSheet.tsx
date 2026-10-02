// @ds-adherence-ignore -- sheet chrome extracted 1:1 from scheme-mobile.dc.html (raw px/hex by
// design §8.3). Lives in design/ because both chromes use it: the mobile screens compose it through
// mobile/ui/kit, and shared features (login, rate limit) render it on a narrow viewport.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { useBackDismiss } from './use-back-dismiss';
import { MobileOverlayPortal } from './mobile-overlay-host';
import { useSheetHeight } from './use-sheet-height';

const SHEET_MS = 300; // entrance, snap-back, and fling-out share this duration
const SHEET_EASE = 'cubic-bezier(.32,.72,0,1)';
type Phase = 'enter' | 'open' | 'exit';
type Drag = { startY: number; lastY: number; lastT: number; v: number };

interface BottomSheetProps {
  onClose: () => void;
  /** Hardware-back/Escape action for a nested level; dim/drag still close the whole sheet. */
  onBack?: () => void;
  children: ReactNode;
  /** The dimmed background screen shown behind the sheet. */
  behind?: ReactNode;
  /** Scope classes for the portaled sheet root. */
  className?: string;
  /** Opt in to natural content height transitions; other sheets keep their existing layout. */
  animateHeight?: boolean;
}

/** Close past ~28% of the sheet height, or on a fast downward flick (px/ms). */
export function shouldFlingClose(dragY: number, height: number, velocity: number): boolean {
  return dragY > height * 0.28 || velocity > 0.55;
}

function useSheetEntrance(setPhase: (phase: Phase) => void): void {
  useEffect(() => {
    // Double rAF paints the offscreen frame before starting the entrance transition.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setPhase('open'));
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [setPhase]);
}

function useSheetClose(onClose: () => void, setPhase: (phase: Phase) => void, setDragging: (value: boolean) => void) {
  const closed = useRef(false);
  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    setDragging(false);
    setPhase('exit');
    window.setTimeout(onClose, SHEET_MS);
  }, [onClose, setPhase, setDragging]);
  return { close, closed };
}

function useSheetBack(onBack: (() => void) | undefined, close: () => void): void {
  const [hardwareBackEpoch, setHardwareBackEpoch] = useState(0);
  // Only hardware back consumes the sentinel; ordinary in-sheet taps don't churn history.
  const onHardwareBack = useCallback(() => {
    if (!onBack) return close();
    onBack();
    setHardwareBackEpoch((value) => value + 1);
  }, [close, onBack]);
  useBackDismiss(onHardwareBack, hardwareBackEpoch);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      (onBack ?? close)();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, onBack]);
}

function moveDrag(drag: Drag | null, clientY: number, setDragY: (y: number) => void): void {
  if (!drag) return;
  const now = performance.now();
  const dt = now - drag.lastT;
  if (dt > 0) drag.v = (clientY - drag.lastY) / dt;
  drag.lastY = clientY;
  drag.lastT = now;
  setDragY(Math.max(0, clientY - drag.startY));
}

function useSheetDrag(sheetRef: RefObject<HTMLDivElement>, closed: RefObject<boolean>, close: () => void, setDragging: (value: boolean) => void) {
  const [dragY, setDragY] = useState(0);
  const drag = useRef<Drag | null>(null);
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (closed.current) return;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    drag.current = { startY: event.clientY, lastY: event.clientY, lastT: performance.now(), v: 0 };
    setDragging(true);
  }, [closed, setDragging]);
  const onPointerMove = useCallback((event: React.PointerEvent) => moveDrag(drag.current, event.clientY, setDragY), []);
  const onPointerUp = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    setDragging(false);
    if (shouldFlingClose(dragY, sheetRef.current?.offsetHeight ?? 320, current?.v ?? 0)) close();
    else setDragY(0);
  }, [dragY, sheetRef, close, setDragging]);
  return { dragY, onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}

function useSheetMotion(props: BottomSheetProps, sheetRef: RefObject<HTMLDivElement>) {
  const [phase, setPhase] = useState<Phase>('enter');
  const [dragging, setDragging] = useState(false);
  useSheetEntrance(setPhase);
  const { close, closed } = useSheetClose(props.onClose, setPhase, setDragging);
  useSheetBack(props.onBack, close);
  const { dragY, ...handle } = useSheetDrag(sheetRef, closed, close, setDragging);
  const offscreen = phase === 'enter' || phase === 'exit';
  const translateY = offscreen ? '100%' : `${dragY}px`;
  const dimOpacity = offscreen ? 0 : Math.max(0, 0.38 * (1 - dragY / (sheetRef.current?.offsetHeight ?? 1)));
  return { close, handle, dragging, translateY, dimOpacity };
}

type SheetMotion = ReturnType<typeof useSheetMotion>;
type SheetSize = ReturnType<typeof useSheetHeight>;

const SHEET_STYLE: CSSProperties = {
  position: 'absolute', left: 0, right: 0, bottom: 0,
  // One backdrop sample for the settled sheet, never for its scrolling rows.
  background: 'var(--material-overlay-bg)', backdropFilter: 'var(--glass-filter)', WebkitBackdropFilter: 'var(--glass-filter)',
  borderRadius: 'var(--r-float) var(--r-float) 0 0', boxShadow: 'var(--material-overlay-shadow)',
  padding: '8px 14px 36px', paddingBottom: 'calc(36px + env(safe-area-inset-bottom))', boxSizing: 'border-box',
  maxHeight: 'calc(100% - max(12px, env(safe-area-inset-top)))',
  display: 'flex', flexDirection: 'column', overflow: 'hidden', willChange: 'transform',
};

function SheetHandle({ motion, animateHeight }: { motion: SheetMotion; animateHeight?: boolean }): JSX.Element {
  return (
    <div {...motion.handle} style={{ margin: '-8px -14px 0', padding: '10px 14px 6px', cursor: 'grab', touchAction: 'none', flexShrink: animateHeight ? 0 : undefined }}>
      <div style={{ width: 36, height: 5, borderRadius: 'var(--r-pill)', background: 'var(--proto-line-3)', margin: '0 auto 12px' }} />
    </div>
  );
}

function SheetContent({ size, animateHeight, children }: { size: SheetSize; animateHeight?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div ref={size.scrollRef} data-mobile-sheet-scroll="true" style={{
      flex: 1, minHeight: 0, overflowX: 'hidden', overflowY: 'auto',
      scrollbarGutter: animateHeight ? 'stable' : undefined,
      overscrollBehavior: 'contain', touchAction: 'pan-y', WebkitOverflowScrolling: 'touch',
    }}>
      {animateHeight ? <div ref={size.contentRef} data-mobile-sheet-content style={{ display: 'flow-root' }}>{children}</div> : children}
    </div>
  );
}

function SheetSurface({ size, motion, animateHeight, children }: { size: SheetSize; motion: SheetMotion; animateHeight?: boolean; children: ReactNode }): JSX.Element {
  return (
    <div ref={size.sheetRef} data-mobile-sheet style={{
      ...SHEET_STYLE, height: size.height, transform: `translateY(${motion.translateY})`,
      transition: motion.dragging ? 'none' : `transform ${SHEET_MS}ms ${SHEET_EASE}${animateHeight ? ', height 200ms ease-out' : ''}`,
    }}>
      <SheetHandle motion={motion} animateHeight={animateHeight} />
      <SheetContent size={size} animateHeight={animateHeight}>{children}</SheetContent>
    </div>
  );
}

/** Dimmed overlay + bottom-anchored sheet. Dim and drag share the animated close. */
export function MBottomSheet(props: BottomSheetProps): JSX.Element {
  const { animateHeight = false, children, behind, className } = props;
  const size = useSheetHeight(animateHeight, children);
  const motion = useSheetMotion(props, size.sheetRef);
  return (
    <MobileOverlayPortal>
      <div ref={size.hostRef} data-mobile-sheet-host className={className} style={{
        position: 'absolute', inset: 0, zIndex: 10, boxSizing: 'border-box', pointerEvents: 'auto',
        paddingTop: animateHeight ? 'max(12px, env(safe-area-inset-top))' : undefined,
      }}>
        {behind && <div style={{ position: 'absolute', inset: 0 }}>{behind}</div>}
        <div onClick={motion.close} style={{
          position: 'absolute', inset: 0, background: 'var(--overlay-ink)', opacity: motion.dimOpacity,
          transition: motion.dragging ? 'none' : `opacity ${SHEET_MS}ms ${SHEET_EASE}`,
        }} />
        <SheetSurface size={size} motion={motion} animateHeight={animateHeight}>{children}</SheetSurface>
      </div>
    </MobileOverlayPortal>
  );
}
