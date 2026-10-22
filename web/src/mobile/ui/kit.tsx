//
// Pure — no data, no tRPC. The full-bleed shell (MobileShell) owns the viewport; a screen renders
// <MScreen> with its own header, scroll body, and optional footer.
import { Children, Fragment, type ButtonHTMLAttributes, type CSSProperties, type ReactNode, type UIEvent, isValidElement, useLayoutEffect, useRef, useState } from 'react';
import type { Tone } from '@/design/tone';
import { MC, M_GUTTER, M_NUM } from '@/design/mobile-tokens';
import { useVocabOptional } from '@/i18n';

export { MC, MONO, M_FLOAT_BOTTOM, M_GUTTER, M_NUM, M_TAB_BODY_PADDING } from '@/design/mobile-tokens';
// MBottomSheet lives in design/ (both chromes use it); the mobile screens keep importing it from
// the kit they compose everything else from.
export { MBottomSheet } from '@/design';
export { MComposer } from './composer';
export { MSelect, type MSelectOption, type MSelectProps } from '@/design/MSelect';

// ── Palette (scheme-mobile.dc.html system tokens, L57-73) ─────────────────────
// Each value resolves to a CSS variable (defined in src/index.css `:root` / `[data-theme='dark']`)
// so the whole mobile surface re-themes on the single `data-theme` flip — the light values are the
// exact original scheme-mobile hexes, the dark values follow scheme-dark 1b–1d. Card/page surfaces
// (`--m-*`) run a touch darker than desktop; `--ink-solid-*` handles the inverted send/stop keys.

// ── MScreen — the flex-column frame (header · scroll body · optional footer) ───
// `floatingHeader` lifts the header out of the flow: it hovers over the scroller and the content
// scrolls underneath it. Its measured height is published as `--m-header-clearance`, which
// MScrollBody spends as a top spacer so the first row still starts below the header. The header
// sits flat on the mesh at rest and takes its glass (fill, blur, bottom hairline) only once content
// has scrolled under it — published as the `--m-header-*` variables MTabHeader paints with.
const HEADER_AT_REST = {} as CSSProperties;
const HEADER_SCROLLED = {
  '--m-header-bg': MC.glass,
  '--m-header-filter': MC.glassFilter,
  '--m-header-edge': '0 1px 0 var(--proto-line)',
} as CSSProperties;

function useFloatingHeader(enabled: boolean) {
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [clearance, setClearance] = useState(0);
  const [scrolled, setScrolled] = useState(false);
  useLayoutEffect(() => {
    const el = headerRef.current;
    if (!enabled || !el) return;
    const measure = () => setClearance(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled]);
  const onScroll = (event: UIEvent<HTMLDivElement>) => setScrolled(event.currentTarget.scrollTop > 2);
  return { headerRef, clearance, scrolled, onScroll };
}

const SCREEN_STYLE: CSSProperties = {
  height: '100%',
  minWidth: 0,
  overflowWrap: 'anywhere',
  position: 'relative',
  display: 'flex',
  flexDirection: 'column',
  boxSizing: 'border-box',
  // No fill: the screen shares the shell's mesh.
  background: 'transparent',
};

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
  const floating = floatingHeader && header != null;
  const { headerRef, clearance, scrolled, onScroll } = useFloatingHeader(floating);
  return (
    <div
      data-screen-label={label}
      style={{ ...SCREEN_STYLE, ...(floating ? { '--m-header-clearance': `${clearance}px` } : {}), ...style } as CSSProperties}
    >
      {floating ? (
        <div
          ref={headerRef}
          data-floating-header="true"
          data-scrolled={scrolled ? 'true' : 'false'}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 5, pointerEvents: 'none', ...(scrolled ? HEADER_SCROLLED : HEADER_AT_REST) }}
        >
          {header}
        </div>
      ) : (
        header
      )}
      <div
        data-m-scroller=""
        onScroll={floating ? onScroll : undefined}
        style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
      >
        {children}
      </div>
      {footer}
      {overlay}
    </div>
  );
}

// ── MTabHeader — the tab header (会话 / 线程 / 任务 / 项目) ──────────────────────
// A full-bleed bar under the status bar (render it through `MScreen floatingHeader`): the 24/680
// title sits straight on the mesh at rest and the bar frosts once rows scroll beneath it. The title
// shares the row text x (gutter + 14). Optional `leading` (brand mark), passive QN scope tag,
// `trailing` keys (bare — no frame of their own) and a `below` second row (线程 budget band).
// `titleMenu` turns the title into a ▾ button (会话: the title is the current project).
const TAB_TITLE: CSSProperties = {
  fontSize: 24, fontWeight: 680, color: MC.ink, letterSpacing: '-.01em',
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const TAB_TITLE_BUTTON: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, minHeight: 44,
  margin: 0, padding: 0, border: 0, background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer',
};

export interface MTabTitleMenu {
  /** Accessible action name, read together with the title. */
  label: string;
  onOpen: () => void;
}

function TabTitle({ title, menu }: { title: string; menu?: MTabTitleMenu }) {
  if (!menu) return <span style={TAB_TITLE}>{title}</span>;
  return (
    <button type="button" aria-label={`${menu.label}: ${title}`} aria-haspopup="dialog" onClick={menu.onOpen} style={TAB_TITLE_BUTTON}>
      <span style={TAB_TITLE}>{title}</span>
      <svg width={14} height={14} viewBox="0 0 10 10" fill="none" aria-hidden="true" style={{ flex: 'none', color: MC.muted }}>
        <path d="M2.2 3.8 5 6.6l2.8-2.8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function ScopeTag({ text }: { text: string }) {
  return (
    <span style={{ fontSize: 11, fontWeight: 600, color: MC.sub, background: 'var(--proto-gray)', padding: '2px 7px', borderRadius: 6, flex: 'none' }}>
      {text}
    </span>
  );
}

function tabHeaderStyle(hasBelow: boolean): CSSProperties {
  return {
    flex: 'none',
    pointerEvents: 'auto',
    padding: `calc(6px + env(safe-area-inset-top)) ${M_GUTTER}px ${hasBelow ? 12 : 6}px`,
    background: 'var(--m-header-bg, transparent)',
    backdropFilter: 'var(--m-header-filter, none)',
    WebkitBackdropFilter: 'var(--m-header-filter, none)',
    boxShadow: 'var(--m-header-edge, none)',
    transition: 'background-color .2s, box-shadow .2s',
  };
}

export function MTabHeader({ title, titleMenu, leading, qn, trailing, below }: {
  title: string;
  titleMenu?: MTabTitleMenu;
  /** Rendered before the title (brand mark / presence). */
  leading?: ReactNode;
  /** Passive project-scope tag (real current-project initials, e.g. "NI"); omitted → no tag. */
  qn?: string;
  trailing?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div data-tab-header="true" style={tabHeaderStyle(!!below)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 48, paddingLeft: 14 }}>
        {leading}
        <TabTitle title={title} menu={titleMenu} />
        {qn && <ScopeTag text={qn} />}
        {trailing && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>{trailing}</div>}
      </div>
      {below && <div style={{ padding: '0 14px' }}>{below}</div>}
    </div>
  );
}

// ── MDrillHeader — ‹ back + middle content + trailing (⋯ / pill) ───────────────
// Back chevron in ink (the accent is for links and running, not for navigation chrome) + middle
// (title/statusline) + trailing slot.

/** The drill-in back glyph every mobile header shares: a stroked chevron in the current colour. */
export function MBackChevron({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3.5 5.5 8l4.5 4.5" />
    </svg>
  );
}

export function MDrillHeader({
  onBack,
  children,
  trailing,
}: {
  onBack: () => void;
  children: ReactNode;
  trailing?: ReactNode;
}) {
  const vocab = useVocabOptional();
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
        aria-label={vocab.back}
        onClick={onBack}
        style={{
          border: 'none',
          background: 'transparent',
          color: MC.ink,
          padding: 0,
          margin: '0 -6px 0 -10px',
          cursor: 'pointer',
          flex: 'none',
          minHeight: 44,
          minWidth: 44,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <MBackChevron />
      </button>
      {children}
      {trailing && <div style={{ marginLeft: 'auto', minWidth: 0, maxWidth: '100%', overflowWrap: 'anywhere' }}>{trailing}</div>}
    </div>
  );
}

// The ⋯ key used in drill headers (rename/export/archive menu trigger): a bare muted glyph — the
// header is already the frame, so the key takes no fill or ring of its own.
export function MMoreButton({ onClick }: { onClick?: () => void }) {
  const vocab = useVocabOptional();
  return (
    <button
      type="button"
      aria-label={vocab.more}
      onClick={onClick}
      style={{
        width: 44,
        height: 44,
        borderRadius: 'var(--r-control)',
        background: 'transparent',
        border: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: MC.muted,
        fontSize: 18,
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
      {/* Bottom gutter: rows scroll clear of the home indicator. */}
      <div style={{ height: 'calc(20px + env(safe-area-inset-bottom))', flex: 'none' }} />
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

// ── MButton — the 44px action key ──────────────────────────────────────────────────────────────
// Ink-filled for the one decision a card or a sheet asks for, a hairline outline for the rest (the
// accent marks focus, links and running — never a button's fill or ring). `compact` is for actions
// that sit inside a row: chip corners and tighter padding, same touch height.
export type MButtonVariant = 'ink' | 'outline' | 'danger-outline';
const M_BUTTON_TONE: Record<MButtonVariant, { bg: string; fg: string; line?: string }> = {
  ink: { bg: MC.inkSolid, fg: MC.inkSolidFg },
  outline: { bg: 'var(--material-control-bg)', fg: MC.ink, line: 'var(--proto-line-3)' },
  'danger-outline': { bg: 'var(--material-control-bg)', fg: 'var(--proto-danger)', line: 'var(--proto-danger-bg)' },
};
const M_BUTTON_FULL = { padding: '0 8px', fontSize: 15, borderRadius: 'var(--r-control)', lineWidth: 1 };
const M_BUTTON_COMPACT = { padding: '0 12px', fontSize: 13, borderRadius: 'var(--r-chip)', lineWidth: 1 };
export interface MButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: MButtonVariant;
  compact?: boolean;
}
export function MButton({ variant = 'outline', compact = false, disabled, style, type = 'button', ...rest }: MButtonProps) {
  const tone = M_BUTTON_TONE[variant];
  const { lineWidth, ...box } = compact ? M_BUTTON_COMPACT : M_BUTTON_FULL;
  return (
    <button
      type={type}
      disabled={disabled}
      style={{
        ...box,
        height: 44,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        boxSizing: 'border-box',
        background: tone.bg,
        color: tone.fg,
        border: tone.line ? `${lineWidth}px solid ${tone.line}` : 'none',
        boxShadow: tone.line ? 'var(--material-control-shadow)' : undefined,
        fontFamily: 'inherit',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
      {...rest}
    />
  );
}

// ── MCollapsedCard — a queue entry folded to one line; tap to expand ─────────────────────────────
export function MCollapsedCard({ title, meta, leading, sub, onExpand }: {
  title: ReactNode;
  meta?: ReactNode;
  leading?: ReactNode;
  sub?: ReactNode;
  onExpand: () => void;
}) {
  return (
    <MCard padding="11px 14px" onClick={onExpand}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden' }}>
        {leading}
        <span style={{ fontSize: 13, fontWeight: 600, color: MC.body, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {title}
        </span>
        {meta && <span style={{ fontSize: 12, color: MC.muted, flex: 'none', ...M_NUM }}>{meta}</span>}
      </div>
      {sub && <div style={{ fontSize: 12, color: MC.muted, marginTop: 5, paddingLeft: 2, ...M_NUM }}>{sub}</div>}
    </MCard>
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

// ── MDot — small status dot ──
export function MDot({
  color,
  size = 6,
  style,
}: {
  color: string;
  size?: number;
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
        ...style,
      }}
    />
  );
}

// ── MGroupLabel — the section header above a group (进行中 · 1) ──────────────────
// Sentence case at body weight, inset to the row text so the label, rows and dividers share one x.
export function MGroupLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        color: MC.muted,
        padding: '0 14px 6px',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ── MGroup — a run of rows laid straight on the mesh, split by inset hairlines ─────────
// No pane of its own: only the header floats, so a list never reads as a stack of
// boxes. `inset` is where a divider starts (the row text x), so dividers never run under a glyph.
export function MGroup({
  children,
  inset = 14,
  style,
}: {
  children: ReactNode;
  inset?: number;
  style?: CSSProperties;
}) {
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <div data-m-group="" style={{ minWidth: 0, ...style }}>
      {rows.map((row, index) => (
        <Fragment key={row.key ?? index}>
          {index > 0 && <div aria-hidden="true" style={{ height: 1, marginLeft: inset, background: 'var(--proto-line)' }} />}
          {row}
        </Fragment>
      ))}
    </div>
  );
}

// ── MEmpty — centered empty state for a tab list ─────────────────────────────────
export function MEmpty({ children }: { children: ReactNode }) {
  return (
    <div style={{ padding: '56px 24px', textAlign: 'center', color: MC.muted, fontSize: 13 }}>
      {children}
    </div>
  );
}
