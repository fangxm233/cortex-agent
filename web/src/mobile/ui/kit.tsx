//
// Pure — no data, no tRPC. The full-bleed shell (MobileShell) owns the viewport + floating Tab bar;
// a screen renders <MScreen> with its own header, scroll body, and optional footer.
import { Children, Fragment, type CSSProperties, type ReactNode, type UIEvent, isValidElement, useLayoutEffect, useRef, useState } from 'react';
import { statusTone, type Tone } from '@/design/tone';
import { MC, M_GUTTER } from '@/design/mobile-tokens';
import { useVocabOptional } from '@/i18n';

export { MC, MONO, M_FLOAT_TOP, M_TABBAR_BOTTOM, M_GUTTER, M_NUM, M_TAB_BODY_PADDING } from '@/design/mobile-tokens';
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
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          // Floating chrome: rows vanish at the Tab bar's bottom edge instead of showing, unblurred,
          // over the home indicator. The header bar runs to the top edge and blurs what passes under it.
          clipPath: floating ? 'inset(0 0 var(--m-tabbar-bottom, 0px) 0)' : undefined,
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
// A full-bleed bar under the status bar (render it through `MScreen floatingHeader`): the 22/700
// title sits straight on the mesh at rest and the bar frosts once rows scroll beneath it. The title
// shares the row text x (gutter + 14). Optional `leading` (brand mark), passive QN scope tag,
// `trailing` keys (bare — no frame of their own) and a `below` second row (线程 budget band).
export function MTabHeader({
  title,
  leading,
  qn,
  trailing,
  below,
}: {
  title: string;
  /** Rendered before the title (brand mark / presence). */
  leading?: ReactNode;
  /** Passive project-scope tag (real current-project initials, e.g. "NI"); omitted → no tag. */
  qn?: string;
  trailing?: ReactNode;
  below?: ReactNode;
}) {
  return (
    <div
      data-tab-header="true"
      style={{
        flex: 'none',
        pointerEvents: 'auto',
        padding: `calc(6px + env(safe-area-inset-top)) ${M_GUTTER}px ${below ? 12 : 6}px`,
        background: 'var(--m-header-bg, transparent)',
        backdropFilter: 'var(--m-header-filter, none)',
        WebkitBackdropFilter: 'var(--m-header-filter, none)',
        boxShadow: 'var(--m-header-edge, none)',
        transition: 'background-color .2s, box-shadow .2s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, minHeight: 48, paddingLeft: 14 }}>
        {leading}
        <span
          style={{ fontSize: 22, fontWeight: 700, color: MC.ink, letterSpacing: '-.02em', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {title}
        </span>
        {qn && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 650,
              color: MC.run,
              background: MC.runBg,
              padding: '2px 7px',
              borderRadius: 'var(--r-pill)',
              flex: 'none',
            }}
          >
            {qn}
          </span>
        )}
        {trailing && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>{trailing}</div>}
      </div>
      {below && <div style={{ padding: '0 14px' }}>{below}</div>}
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
  const vocab = useVocabOptional();
  return (
    <button
      type="button"
      aria-label={vocab.more}
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
// No pane of its own: only the header and the Tab bar float, so a list never reads as a stack of
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
