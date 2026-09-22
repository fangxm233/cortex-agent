// input:  React, mobile kit, presentation props
// output: Mobile UI primitives
// pos:    Mobile frames, cards, labels and sheets
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { statusTone, type Tone } from '@/design/tone';
import { useBackDismiss } from '@/mobile/use-back-dismiss';
import { MC, MONO } from './mobile-theme';

export { MC, MONO } from './mobile-theme';
export {
  ComposerFullscreen,
  MComposer,
  composerCharCount,
  composerCountLabel,
  composerLineCount,
  type ComposerFullscreenProps,
  type MComposerProps,
} from './composer';

// ── Palette (scheme-mobile.dc.html system tokens, L57-73) ─────────────────────
// Each value resolves to a CSS variable (defined in src/index.css `:root` / `[data-theme='dark']`)
// so the whole mobile surface re-themes on the single `data-theme` flip — the light values are the
// exact original scheme-mobile hexes, the dark values follow scheme-dark 1b–1d. Card/page surfaces
// (`--m-*`) run a touch darker than desktop; `--ink-solid-*` handles the inverted send/stop keys.

// ── MScreen — the flex-column frame (header · scroll body · optional footer) ───
export function MScreen({
  header,
  footer,
  overlay,
  children,
  label,
  style,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  /** Absolutely-positioned screen chrome (FAB, etc.) — anchored to the frame, outside the scroller. */
  overlay?: ReactNode;
  children: ReactNode;
  /** data-screen-label for verification shots (mirrors the scheme's data-screen-label). */
  label?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      data-screen-label={label}
      style={{
        height: '100%',
        minWidth: 0,
        overflowWrap: 'anywhere',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        // No fill: the screen IS the mesh ground the shell painted. Cards inside stay opaque.
        background: 'transparent',
        ...style,
      }}
    >
      {header}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
      {footer}
      {overlay}
    </div>
  );
}

// ── MTabHeader — the big-title tab header (会话 / 线程 / 任务 / 项目) ───────────
// 22/700 title, an optional `leading` slot (brand tile), an optional passive QN scope tag and a
// trailing slot (＋ / segment / daemon status). `below` renders an optional second row (线程 budget
// band, etc.). Top padding reserves the OS status-bar inset.
export function MTabHeader({
  title,
  leading,
  qn,
  trailing,
  below,
}: {
  title: string;
  /** Rendered before the title (brand tile / presence). */
  leading?: ReactNode;
  /** Passive project-scope tag (real current-project initials, e.g. "NI"); omitted → no tag. */
  qn?: string;
  trailing?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div
      style={{
        flex: 'none',
        // Unfilled and unruled: the header sits straight on the mesh ground the shell painted.
        padding: '0 16px 10px',
        paddingTop: 'calc(18px + env(safe-area-inset-top))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {leading}
        <span
          style={{ fontSize: 22, fontWeight: 700, color: MC.ink, letterSpacing: '-.02em', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {title}
        </span>
        {qn && (
          <span
            style={{
              font: `600 11px ${MONO}`,
              color: MC.run,
              background: MC.runBg,
              padding: '2px 7px',
              borderRadius: 4,
              flex: 'none',
            }}
          >
            {qn}
          </span>
        )}
        {trailing && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>{trailing}</div>}
      </div>
      {below}
    </div>
  );
}

// ── MDrillHeader — ‹ back + middle content + trailing (⋯ / pill) ───────────────
// scheme 1b/1f/1g L136-143: 15px accent chevron + middle (title/statusline) + trailing slot.
export function MDrillHeader({
  onBack,
  children,
  trailing,
}: {
  onBack: () => void;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div
      style={{
        flex: 'none',
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        // Transparent over the ground, like MTabHeader — every mobile header reads as one surface.
        padding: '8px 14px 10px',
        paddingTop: 'calc(8px + env(safe-area-inset-top))',
      }}
    >
      <button
        type="button"
        aria-label="Back"
        onClick={onBack}
        style={{
          border: 'none',
          background: 'transparent',
          color: MC.run,
          fontSize: 22,
          lineHeight: 1,
          padding: '0 2px',
          margin: 0,
          cursor: 'pointer',
          flex: 'none',
          minHeight: 44,
          minWidth: 44,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        ‹
      </button>
      {children}
      {trailing && <div style={{ marginLeft: 'auto', minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>{trailing}</div>}
    </div>
  );
}

// The ⋯ round button used in drill headers (rename/export/archive menu trigger).
export function MMoreButton({ onClick }: { onClick?: () => void }) {
  return (
    <button
      type="button"
      aria-label="More"
      onClick={onClick}
      style={{
        width: 44,
        height: 44,
        borderRadius: '50%',
        background: MC.card,
        border: `1px solid ${MC.hairline}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: MC.muted,
        fontSize: 14,
        letterSpacing: 1,
        cursor: 'pointer',
      }}
    >
      ⋯
    </button>
  );
}

// ── MScrollBody — the standard 12/14 padded scroll region content wrapper ──────
export function MScrollBody({
  children,
  gap = 10,
  padding = '12px 14px 0',
}: {
  children: ReactNode;
  gap?: number;
  padding?: string;
}) {
  return (
    <div
      style={{
        padding,
        display: 'flex',
        flexDirection: 'column',
        gap,
      }}
    >
      {children}
      {/* Bottom gutter: the home-indicator inset plus, on a Tab route, the room the floating Tab bar
          takes out of the viewport (`--m-tabbar-clearance`, published by MobileShell; 0 elsewhere). */}
      <div
        style={{
          height: 'calc(20px + env(safe-area-inset-bottom) + var(--m-tabbar-clearance, 0px))',
          flex: 'none',
        }}
      />
    </div>
  );
}

// ── MCard — opaque rounded surface ────────────────────────────────────────────
// The fill stays OPAQUE (`--m-card`) rather than translucent glass, which is the one deliberate
// break from the desktop skin: a card is the unit that repeats down a long mobile list, and one
// translucent card stacked over the next reads as a smudge. A container that wraps a whole section
// (the 会话 day group) is a different shape — it has only the ground behind it, so it takes
// `--glass-2`, which composites without a `backdrop-filter` and stays cheap inside a scroller.
export type CardTone = 'default' | 'blue' | 'amber' | 'fail';
const CARD_BORDER: Record<CardTone, string> = {
  default: MC.cardBorder,
  blue: MC.runBorder,
  amber: MC.amberBorder,
  fail: MC.failBorder,
};
export function MCard({
  tone = 'default',
  radius = 'var(--r-card)',
  padding = '11px 13px',
  onClick,
  children,
  style,
}: {
  tone?: CardTone;
  radius?: number | string;
  padding?: number | string;
  onClick?: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: MC.card,
        border: `1px solid ${CARD_BORDER[tone]}`,
        borderRadius: radius,
        padding,
        boxSizing: 'border-box',
        minWidth: 0,
        overflowWrap: 'anywhere',
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── MPill — status pill (tone → bg/fg) ────────────────────────────────────────
export type PillTone = Tone;
const PILL: Record<PillTone, { bg: string; fg: string }> = {
  running: { bg: MC.runBg, fg: MC.run },
  waiting: { bg: MC.amberBg, fg: MC.amberInk },
  done: { bg: MC.doneBg, fg: MC.done },
  failed: { bg: MC.failBg, fg: MC.fail },
  cancelled: { bg: MC.gray, fg: MC.grayInk },
};
export function MPill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  const c = PILL[tone];
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 'var(--r-pill)',
        background: c.bg,
        color: c.fg,
        flex: 'none',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

// Keep the mobile facade while delegating all status semantics to the canonical design model.
export function statusPillTone(status: string): PillTone {
  return statusTone(status);
}

// ── MDot — small status dot, optional pulse (uses the cxpulse keyframes in index.css) ──
export function MDot({
  color,
  size = 6,
  pulse = false,
  style,
}: {
  color: string;
  size?: number;
  pulse?: boolean;
  style?: CSSProperties;
}) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flex: 'none',
        display: 'inline-block',
        animation: pulse ? 'cxpulse 1.6s ease-in-out infinite' : undefined,
        ...style,
      }}
    />
  );
}

// ── MGroupLabel — the tiny section header (今天 / 进行中 · 1) ───────────────────
export function MGroupLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '.07em',
        color: MC.muted,
        padding: '0 2px 2px',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── MSegmented — segmented control (scheme 1c L183-186) ───────────────────────
export interface SegOption<T extends string> {
  id: T;
  label: string;
}
export function MSegmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div style={{ display: 'flex', background: MC.hairline, borderRadius: 'var(--r-control)', padding: 2 }}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.id)}
            style={{
              border: 'none',
              cursor: 'pointer',
              fontSize: 11.5,
              fontWeight: 600,
              color: active ? MC.ink : MC.muted,
              background: active ? MC.card : 'transparent',
              borderRadius: 'var(--r-chip)',
              padding: '4px 12px',
              minHeight: 44,
              boxShadow: active ? 'var(--shadow-segment)' : undefined,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

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
          // Blur #2 of the three (see MC's blur budget): a bottom sheet is a single overlay that
          // holds still once it has settled — the list inside it scrolls, the sheet does not. The
          // fill is the denser `--glass-2`, as on the desktop Drawer: this sheet covers real
          // content rather than the smooth ground, so the thinner pane alpha would read as noise.
          background: 'var(--glass-2)',
          backdropFilter: 'var(--glass-filter)',
          WebkitBackdropFilter: 'var(--glass-filter)',
          borderRadius: 'var(--r-float) var(--r-float) 0 0',
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
          <div style={{ width: 36, height: 5, borderRadius: 'var(--r-pill)', background: 'var(--proto-line-3)', margin: '0 auto 12px' }} />
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
