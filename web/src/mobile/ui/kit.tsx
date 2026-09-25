// input:  React, mobile kit, presentation props
// output: Mobile UI primitives
// pos:    Mobile frames, floating glass header and cards, controls and sheets
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
//
// Pure — no data, no tRPC. The full-bleed shell (MobileShell) owns the viewport + floating Tab bar;
// a screen renders <MScreen> with its own header, scroll body, and optional footer.
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { statusTone, type Tone } from '@/design/tone';
import { MC, MONO, M_FLOAT_TOP } from '@/design/mobile-tokens';

export { MC, MONO, M_FLOAT_TOP, M_TABBAR_BOTTOM } from '@/design/mobile-tokens';
// MBottomSheet lives in design/ (both chromes use it); the mobile screens keep importing it from
// the kit they compose everything else from.
export { MBottomSheet, shouldFlingClose } from '@/design';
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
// `floatingHeader` lifts the header out of the flow: it hovers over the scroller as glass chrome and
// the content scrolls underneath it. Its measured height is published as `--m-header-clearance`,
// which MScrollBody spends as a top spacer so the first card still starts below the header.
export function MScreen({
  header,
  footer,
  overlay,
  floatingHeader = false,
  children,
  label,
  style,
}: {
  header?: ReactNode;
  footer?: ReactNode;
  /** Absolutely-positioned screen chrome (FAB, etc.) — anchored to the frame, outside the scroller. */
  overlay?: ReactNode;
  /** Float the header over the scroller (tab screens) instead of docking it above. */
  floatingHeader?: boolean;
  children: ReactNode;
  /** data-screen-label for verification shots (mirrors the scheme's data-screen-label). */
  label?: string;
  style?: CSSProperties;
}) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [clearance, setClearance] = useState(0);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!floatingHeader || !el) return;
    const measure = () => setClearance(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [floatingHeader]);
  const floating = floatingHeader && header != null;
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
        // No fill: the screen shares the shell's mesh; cards choose their own material.
        background: 'transparent',
        ...(floating ? { '--m-header-clearance': `${clearance}px` } : {}),
        ...style,
      } as CSSProperties}
    >
      {floating ? (
        <div
          ref={headerRef}
          data-floating-header="true"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5, pointerEvents: 'none' }}
        >
          {header}
        </div>
      ) : (
        header
      )}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          // Floating chrome: rows vanish at the header pill's top edge and the Tab bar's bottom edge
          // instead of showing, unblurred, under the status bar and the home indicator.
          clipPath: floating ? `inset(${M_FLOAT_TOP} 0 var(--m-tabbar-bottom, 0px) 0)` : undefined,
        }}
      >
        {children}
      </div>
      {footer}
      {overlay}
    </div>
  );
}

// ── MTabHeader — the tab header (会话 / 线程 / 任务 / 项目) ──────────────────────
// A floating glass pill mirroring the Tab bar: blurs whatever scrolls beneath it (render it through
// `MScreen floatingHeader`). 20/700 title, an optional `leading` slot (brand tile), an optional
// passive QN scope tag and a trailing slot. `below` renders a second row inside the pill (线程
// budget band). Keys inside the pill stay bare — the pill is already the frame.
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
        padding: '0 12px',
        paddingTop: M_FLOAT_TOP,
      }}
    >
      <div
        data-tab-header="true"
        style={{
          pointerEvents: 'auto',
          borderRadius: 20,
          background: MC.glass,
          backdropFilter: MC.glassFilter,
          WebkitBackdropFilter: MC.glassFilter,
          boxShadow: '0 0 0 1px var(--proto-line), var(--shadow-chrome-float)',
          padding: below ? '4px 6px 10px 14px' : '4px 6px 4px 14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 44 }}>
          {leading}
          <span
            style={{ fontSize: 20, fontWeight: 700, color: MC.ink, letterSpacing: '-.02em', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
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
        {below && <div style={{ paddingRight: 8 }}>{below}</div>}
      </div>
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
        background: 'var(--material-control-bg)',
        boxShadow: 'var(--material-control-shadow)',
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
      {/* Top gutter under a floating header (`--m-header-clearance`, published by MScreen; 0 elsewhere). */}
      <div style={{ height: 'var(--m-header-clearance, 0px)', flex: 'none', marginBottom: -gap }} />
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

// ── MCard — floating glass card, with no per-card backdrop sampling ─────────────
// Scrolling cards take the thin `--m-float-bg` pane plus a soft drop, never a blur: behind them is
// only the smooth mesh, which a blur would not change. The default edge is the translucent line
// ring (a solid grey border reads as print, not glass); semantic tones keep their coloured border.
// Reading and sticky occlusion surfaces keep MC.card explicitly; changing that token would leak text.
export type CardTone = 'default' | 'blue' | 'amber' | 'fail';
const CARD_BORDER: Record<CardTone, string> = {
  default: 'transparent',
  blue: MC.runBorder,
  amber: MC.amberBorder,
  fail: MC.failBorder,
};
export const M_FLOAT_SURFACE: CSSProperties = {
  background: 'var(--m-float-bg)',
  boxShadow: 'var(--m-float-ring), var(--m-float-shadow)',
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
        ...M_FLOAT_SURFACE,
        boxShadow: tone === 'default' ? M_FLOAT_SURFACE.boxShadow : 'var(--m-float-shadow)',
        border: tone === 'default' ? undefined : `1px solid ${CARD_BORDER[tone]}`,
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
  done: { bg: MC.doneBg, fg: 'color-mix(in srgb, var(--proto-success) 85%, var(--proto-ink))' },
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
    <div style={{ display: 'flex', background: 'var(--material-inset-bg)', borderRadius: 'var(--r-control)', padding: 2 }}>
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
              background: active ? 'var(--material-control-bg)' : 'transparent',
              borderRadius: 'var(--r-chip)',
              padding: '4px 12px',
              minHeight: 44,
              boxShadow: active ? 'var(--material-control-shadow)' : undefined,
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
