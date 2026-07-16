// @ds-adherence-ignore -- mobile v3 UI kit, chrome extracted 1:1 from scheme-mobile.dc.html
// (raw px/hex/font by design §8.3; the mobile palette is not in the light `proto.*` token set).
//
// Shared, presentational building blocks for the mobile v3 screens (1a–1r). Every screen composes
// these so the four-tab redesign reads as one system. Pure — no data, no tRPC. The full-bleed shell
// (MobileShell) owns the viewport + bottom Tab bar; a screen renders <MScreen> with its own header,
// scroll body, and optional footer. Headers reserve the OS status-bar inset via env(safe-area-inset-top).
import { type CSSProperties, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

// ── Palette (scheme-mobile.dc.html system tokens, L57-73) ─────────────────────
export const MC = {
  canvas: '#F2F2F7',
  ink: '#191C22',
  sub: '#5B6472',
  body: '#22262E',
  muted: '#8A93A2',
  faint: '#B6BDC9',
  hairline: '#E7E9EE',
  divider: '#F3F4F7',
  cardBorder: '#E7E9EE',
  run: '#4655D4',
  runBg: '#EEF0FA',
  runBorder: '#C9CFF2',
  amber: '#C99A2E',
  amberInk: '#8A5B06',
  amberText: '#A96B0B',
  amberBg: '#F7ECCE',
  amberBorder: '#EFDDB0',
  amberCard: '#FDF9F0',
  done: '#23854F',
  doneBg: '#E9F4EE',
  fail: '#C03D33',
  failBg: '#FBEDEB',
  failBorder: '#EED3D0',
  gray: '#F1F2F5',
  grayInk: '#8A93A2',
} as const;

export const MONO = "'IBM Plex Mono', ui-monospace, Menlo, monospace";

// ── MScreen — the flex-column frame (header · scroll body · optional footer) ───
export function MScreen({
  header,
  footer,
  children,
  label,
  style,
}: {
  header?: ReactNode;
  footer?: ReactNode;
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
        display: 'flex',
        flexDirection: 'column',
        boxSizing: 'border-box',
        background: MC.canvas,
        ...style,
      }}
    >
      {header}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', background: MC.canvas }}>{children}</div>
      {footer}
    </div>
  );
}

// ── MTabHeader — the big-title tab header (会话 / 线程 / 任务 / 项目) ───────────
// scheme 1a L91-95: 22/700 title + optional passive QN scope tag + a trailing slot (＋ / segment /
// daemon status). `below` renders an optional second row (线程 budget band, etc.). Top padding
// reserves the OS status-bar inset.
export function MTabHeader({
  title,
  qn,
  trailing,
  below,
}: {
  title: string;
  /** Passive project-scope tag (real current-project initials, e.g. "NI"); omitted → no tag. */
  qn?: string;
  trailing?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div
      style={{
        flex: 'none',
        borderBottom: `1px solid ${MC.hairline}`,
        background: MC.canvas,
        padding: '6px 14px 10px',
        paddingTop: 'calc(6px + env(safe-area-inset-top))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <span
          style={{ fontSize: 22, fontWeight: 700, color: MC.ink, letterSpacing: '-.02em', flex: 'none' }}
        >
          {title}
        </span>
        {qn && (
          <span
            style={{
              font: `600 9.5px ${MONO}`,
              color: MC.run,
              background: MC.runBg,
              padding: '2px 7px',
              borderRadius: 4,
              marginLeft: 9,
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
        gap: 9,
        borderBottom: `1px solid ${MC.hairline}`,
        background: MC.canvas,
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
          minWidth: 30,
          display: 'flex',
          alignItems: 'center',
        }}
      >
        ‹
      </button>
      {children}
      {trailing && <div style={{ marginLeft: 'auto', flex: 'none' }}>{trailing}</div>}
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
        width: 34,
        height: 34,
        borderRadius: '50%',
        background: '#fff',
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
export function MScrollBody({ children, gap = 10 }: { children: ReactNode; gap?: number }) {
  return (
    <div
      style={{
        padding: '12px 14px 0',
        display: 'flex',
        flexDirection: 'column',
        gap,
      }}
    >
      {children}
      {/* bottom gutter — non-Tab pages own their home-indicator inset. */}
      <div style={{ height: 'calc(20px + env(safe-area-inset-bottom))', flex: 'none' }} />
    </div>
  );
}

// ── MCard — white rounded surface ─────────────────────────────────────────────
export type CardTone = 'default' | 'blue' | 'amber' | 'fail';
const CARD_BORDER: Record<CardTone, string> = {
  default: MC.cardBorder,
  blue: MC.runBorder,
  amber: MC.amberBorder,
  fail: MC.failBorder,
};
export function MCard({
  tone = 'default',
  radius = 12,
  padding = '11px 13px',
  onClick,
  children,
  style,
}: {
  tone?: CardTone;
  radius?: number;
  padding?: number | string;
  onClick?: () => void;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff',
        border: `1px solid ${CARD_BORDER[tone]}`,
        borderRadius: radius,
        padding,
        boxSizing: 'border-box',
        cursor: onClick ? 'pointer' : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── MPill — status pill (tone → bg/fg) ────────────────────────────────────────
export type PillTone = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
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
        fontSize: 10,
        fontWeight: 600,
        padding: '2px 8px',
        borderRadius: 999,
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

// Map a thread/execution status vocabulary → a pill tone.
export function statusPillTone(status: string): PillTone {
  switch (status) {
    case 'running':
      return 'running';
    case 'waiting':
    case 'rate_limited':
      return 'waiting';
    case 'completed':
    case 'done':
      return 'done';
    case 'failed':
    case 'aborted':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'running';
  }
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
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '.07em',
        color: MC.faint,
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
    <div style={{ display: 'flex', background: MC.hairline, borderRadius: 8, padding: 2 }}>
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
              background: active ? '#fff' : 'transparent',
              borderRadius: 6,
              padding: '4px 12px',
              boxShadow: active ? '0 1px 2px rgba(16,24,40,.06)' : undefined,
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
  children,
  behind,
}: {
  onClose: () => void;
  children: ReactNode;
  /** The dimmed background screen shown behind the sheet. */
  behind?: ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  // Lifecycle: 'enter' (offscreen pre-paint) → 'open' (settled) → 'exit' (flung/tapped closed).
  const [phase, setPhase] = useState<'enter' | 'open' | 'exit'>('enter');
  const [dragY, setDragY] = useState(0); // px the sheet is dragged down (≥0), only while touching
  const [dragging, setDragging] = useState(false);
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
    <div style={{ position: 'absolute', inset: 0, boxSizing: 'border-box' }}>
      {behind && <div style={{ position: 'absolute', inset: 0 }}>{behind}</div>}
      <div
        onClick={close}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(25,28,34,1)',
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
          background: '#F7F8FA',
          borderRadius: '18px 18px 0 0',
          boxShadow: '0 -14px 44px rgba(16,24,40,.28)',
          padding: '8px 14px 36px',
          paddingBottom: 'calc(36px + env(safe-area-inset-bottom))',
          boxSizing: 'border-box',
          transform: `translateY(${translateY})`,
          transition: dragging ? 'none' : `transform ${SHEET_MS}ms ${SHEET_EASE}`,
          touchAction: 'none',
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
          <div style={{ width: 36, height: 5, borderRadius: 999, background: '#D9DCE3', margin: '0 auto 12px' }} />
        </div>
        {children}
      </div>
    </div>
  );
}

// ── MComposer — the bottom message composer (input + send / stop) ─────────────
// scheme 1b L165-168. `above` renders composer chips (profile chip / status line / attachment chips).
// While the session is `running`, the send button swaps for a Stop button (white square on the ink
// bg, mirroring the desktop Composer) so the user can cancel the running agent turn.
export function MComposer({
  placeholder,
  above,
  leading,
  sendEnabled = true,
  value,
  onChange,
  onSend,
  running = false,
  onStop,
  stopEnabled = true,
}: {
  placeholder: string;
  above?: ReactNode;
  leading?: ReactNode;
  sendEnabled?: boolean;
  value?: string;
  onChange?: (v: string) => void;
  onSend?: () => void;
  running?: boolean;
  onStop?: () => void;
  stopEnabled?: boolean;
}) {
  return (
    <div
      style={{
        flex: 'none',
        padding: '6px 14px 34px',
        paddingBottom: 'calc(14px + env(safe-area-inset-bottom))',
        background: MC.canvas,
      }}
    >
      {above}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {leading}
        <input
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && sendEnabled) onSend?.();
          }}
          placeholder={placeholder}
          style={{
            flex: 1,
            height: 46,
            border: '1.5px solid #D9DCE3',
            borderRadius: 14,
            background: '#fff',
            padding: '0 14px',
            fontSize: 13.5,
            color: MC.ink,
            boxSizing: 'border-box',
            outline: 'none',
          }}
        />
        {running ? (
          <button
            type="button"
            aria-label="Stop"
            disabled={!stopEnabled}
            onClick={onStop}
            style={{
              flex: 'none',
              width: 46,
              height: 46,
              borderRadius: 14,
              background: MC.ink,
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: stopEnabled ? 1 : 0.45,
              cursor: stopEnabled ? 'pointer' : 'default',
            }}
          >
            <span style={{ width: 14, height: 14, background: '#fff', borderRadius: 3 }} />
          </button>
        ) : (
          <button
            type="button"
            aria-label="Send"
            disabled={!sendEnabled}
            onClick={onSend}
            style={{
              flex: 'none',
              width: 46,
              height: 46,
              borderRadius: 14,
              background: MC.ink,
              border: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              opacity: sendEnabled ? 1 : 0.45,
              cursor: sendEnabled ? 'pointer' : 'default',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.8">
              <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
