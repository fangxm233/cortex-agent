// @ds-adherence-ignore -- mobile v3 UI kit, chrome extracted 1:1 from scheme-mobile.dc.html
// (raw px/hex/font by design §8.3; the mobile palette is not in the light `proto.*` token set).
//
// Shared, presentational building blocks for the mobile v3 screens (1a–1r). Every screen composes
// these so the four-tab redesign reads as one system. Pure — no data, no tRPC. The full-bleed shell
// (MobileShell) owns the viewport + bottom Tab bar; a screen renders <MScreen> with its own header,
// scroll body, and optional footer. Composer variants share an optional local-command menu slot.
import { type CSSProperties, type ReactNode } from 'react';
import { statusTone, type Tone } from '@/design/tone';
import { MC, MONO } from '@/design/mobile-tokens';

export { MC, MONO } from '@/design/mobile-tokens';
// MBottomSheet moved to design/ (both chromes use it); the mobile screens keep importing it from
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
        background: MC.card,
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
              background: active ? MC.card : 'transparent',
              borderRadius: 6,
              padding: '4px 12px',
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
