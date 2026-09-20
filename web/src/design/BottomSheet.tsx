// @ds-adherence-ignore -- sheet chrome extracted 1:1 from scheme-mobile.dc.html (raw px/hex by
// design §8.3). Lives in design/ because both chromes use it: the mobile screens compose it through
// mobile/ui/kit, and shared features (login, rate limit) render it on a narrow viewport.
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useBackDismiss } from './use-back-dismiss';

// ── MBottomSheet — dimmed overlay + bottom sheet (scheme 1i/1p) ────────────────
// Presents like a native iOS sheet: slides up on mount, fades the dim in, and the grab handle is a
// live drag target — dragging down follows the finger and, past a distance/velocity threshold, flings
// the sheet closed (otherwise it snaps back). Tapping the dim or flinging both run the same animated
// close, so `onClose` fires only after the exit transition finishes (the parent unmounts us on that).
const SHEET_MS = 300; // slide/fade duration (entrance, snap-back, and fling-out share it)
const SHEET_EASE = 'cubic-bezier(.32,.72,0,1)'; // iOS-like decelerate

/**
 * Should a released drag fling the sheet closed (vs snap back)? Pure so the dismiss threshold is
 * unit-testable without simulating pointer events. Closes when the sheet was dragged past ~28% of
 * its height, OR flicked down fast enough (velocity in px/ms) even if the distance is short.
 */
export function shouldFlingClose(dragY: number, height: number, velocity: number): boolean {
  return dragY > height * 0.28 || velocity > 0.55;
}

export function MBottomSheet({
  onClose,
  onBack,
  children,
  behind,
}: {
  onClose: () => void;
  /** Hardware-back/Escape action for a nested level; dim/drag still close the whole sheet. */
  onBack?: () => void;
  children: ReactNode;
  /** The dimmed background screen shown behind the sheet. */
  behind?: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  // Lifecycle: 'enter' (offscreen pre-paint) → 'open' (settled) → 'exit' (flung/tapped closed).
  const [phase, setPhase] = useState<'enter' | 'open' | 'exit'>('enter');
  const [dragY, setDragY] = useState(0); // px the sheet is dragged down (≥0), only while touching
  const [dragging, setDragging] = useState(false);
  const [hardwareBackEpoch, setHardwareBackEpoch] = useState(0);
  const drag = useRef<{ startY: number; lastY: number; lastT: number; v: number } | null>(null);
  const closed = useRef(false);

  // Slide in: after the first paint at the offscreen position, flip to the settled position so the
  // transition animates. Double rAF guarantees the browser painted the 'enter' frame first.
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setPhase('open'));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, []);

  const close = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    setDragging(false);
    setPhase('exit');
    window.setTimeout(onClose, SHEET_MS);
  }, [onClose]);

  // Android/browser back retreats one nested level when supplied. That pop consumed this guard's
  // sentinel without unmounting the sheet, so the epoch re-arms exactly then (ordinary in-sheet
  // taps keep the existing sentinel and do not churn browser history).
  const onHardwareBack = useCallback(() => {
    if (onBack) {
      onBack();
      setHardwareBackEpoch((value) => value + 1);
    } else {
      close();
    }
  }, [close, onBack]);
  useBackDismiss(onHardwareBack, hardwareBackEpoch);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (onBack) onBack();
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, onBack]);

  const onHandleDown = useCallback((e: React.PointerEvent) => {
    if (closed.current) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    const now = performance.now();
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: now, v: 0 };
    setDragging(true);
  }, []);

  const onHandleMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const now = performance.now();
    const dy = Math.max(0, e.clientY - d.startY); // only downward drag moves the sheet
    const dt = now - d.lastT;
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt; // px/ms, signed
    d.lastY = e.clientY;
    d.lastT = now;
    setDragY(dy);
  }, []);

  const onHandleUp = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    const height = sheetRef.current?.offsetHeight ?? 320;
    if (shouldFlingClose(dragY, height, d?.v ?? 0)) close();
    else setDragY(0); // snap back (transition re-enables since dragging is now false)
  }, [dragY, close]);

  // Transform: fully offscreen while entering/exiting, else follow the drag (0 when settled).
  const offscreen = phase === 'enter' || phase === 'exit';
  const translateY = offscreen ? '100%' : `${dragY}px`;
  // Dim tracks the sheet: full while open, fades with drag distance and fully out on enter/exit.
  const height = sheetRef.current?.offsetHeight ?? 1;
  const dimOpacity = offscreen ? 0 : Math.max(0, 0.38 * (1 - dragY / height));

  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 10, boxSizing: 'border-box' }}>
      {behind && <div style={{ position: 'absolute', inset: 0 }}>{behind}</div>}
      <div
        onClick={close}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--overlay-ink)',
          opacity: dimOpacity,
          transition: dragging ? 'none' : `opacity ${SHEET_MS}ms ${SHEET_EASE}`,
        }}
      />
      <div
        ref={sheetRef}
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          background: 'var(--proto-alt)',
          borderRadius: '18px 18px 0 0',
          boxShadow: 'var(--shadow-sheet)',
          padding: '8px 14px 36px',
          paddingBottom: 'calc(36px + env(safe-area-inset-bottom))',
          boxSizing: 'border-box',
          maxHeight: 'calc(100% - max(12px, env(safe-area-inset-top)))',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          transform: `translateY(${translateY})`,
          transition: dragging ? 'none' : `transform ${SHEET_MS}ms ${SHEET_EASE}`,
          willChange: 'transform',
        }}
      >
        {/* grab handle — a live drag target (enlarged hit area) that flings the sheet closed */}
        <div
          onPointerDown={onHandleDown}
          onPointerMove={onHandleMove}
          onPointerUp={onHandleUp}
          onPointerCancel={onHandleUp}
          style={{ margin: '-8px -14px 0', padding: '10px 14px 6px', cursor: 'grab', touchAction: 'none' }}
        >
          <div style={{ width: 36, height: 5, borderRadius: 999, background: 'var(--proto-line-3)', margin: '0 auto 12px' }} />
        </div>
        <div
          data-mobile-sheet-scroll="true"
          style={{
            flex: 1,
            minHeight: 0,
            overflowX: 'hidden',
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            touchAction: 'pan-y',
            WebkitOverflowScrolling: 'touch',
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
