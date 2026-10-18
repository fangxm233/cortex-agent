import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import './settings-style.css';

export function settingsClassName(base: string, extra: unknown): string {
  return typeof extra === 'string' ? `${base} ${extra}` : base;
}

// The code face. Only for things a person would type or paste — paths, URLs, commands, env names —
// never for labels, counts, versions or money, which stay in the UI face with tabular figures.
const MONO = "'IBM Plex Mono',monospace";

// ── Header actions ──────────────────────────────────────────────────────────
/** The panel header's action slot, provided by the settings sheet that hosts the panel. */
export const SettingsHeaderSlotContext = createContext<HTMLElement | null>(null);

/** Panel-level actions (e.g. refresh): drawn in the host header beside close, else inline. */
export function SHeaderActions({ children }: { children: ReactNode }) {
  const slot = useContext(SettingsHeaderSlotContext);
  return slot ? createPortal(children, slot) : <>{children}</>;
}

// ── Grouped rows ────────────────────────────────────────────────────────────
// Cards transmit the sheet's tint without adding a backdrop-filter per row.
export const GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 'var(--settings-card-radius, 12px)',
  background: 'var(--settings-card-fill, var(--material-card-bg))',
  border: '1px solid var(--settings-boundary, var(--proto-line-2))',
  boxShadow: 'var(--material-card-shadow)', boxSizing: 'border-box', minWidth: 0,
  overflow: 'hidden',
};

function dividerStyle(last: boolean): CSSProperties {
  return last ? {} : { borderBottom: '1px solid var(--proto-line-2)' };
}

/** A card of rows. Children are separated by hairlines; the last one is flush with the card edge. */
export function SRowGroup({ children, style, className, ...rest }: {
  children: ReactNode;
  style?: CSSProperties;
} & Record<string, unknown>) {
  const items = Array.isArray(children) ? children.flat() : [children];
  const rows = items.filter((child) => child != null && child !== false);
  return (
    <div {...rest} className={settingsClassName('settings-row-group', className)} style={{ ...GROUP_STYLE, ...style }}>
      {rows.map((child, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={index} style={dividerStyle(index === rows.length - 1)}>{child}</div>
      ))}
    </div>
  );
}

export const ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px',
};

const ROW_TITLE_STYLE: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' };
const ROW_DESC_STYLE: CSSProperties = {
  fontSize: 12, color: 'var(--proto-muted-2)', marginTop: 2, lineHeight: 1.5,
};

/** Title (+ optional description) on the left, a control on the right. */
export function SRow({ title, desc, control, align = 'center', children, className, ...rest }: {
  title: ReactNode;
  desc?: ReactNode;
  control?: ReactNode;
  align?: CSSProperties['alignItems'];
  children?: ReactNode;
} & Record<string, unknown>) {
  return (
    <div {...rest} className={settingsClassName('settings-row', className)} style={{ ...ROW_STYLE, alignItems: align }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="settings-row-title" style={ROW_TITLE_STYLE}>{title}</div>
        {desc != null && <div style={ROW_DESC_STYLE}>{desc}</div>}
        {children}
      </div>
      {control}
    </div>
  );
}

// ── Section heading ─────────────────────────────────────────────────────────
const SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: 12.5, fontWeight: 600, color: 'var(--proto-muted)',
};

/** The sentence-case label above a card, with an optional trailing action. Hierarchy comes from
 *  weight and colour; an uppercase tracked label would read as a code token. */
export function SSection({ label, action, children }: {
  label: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="settings-section-heading" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 8px' }}>
        <span style={SECTION_LABEL_STYLE}>{label}</span>
        {action != null && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      {children}
    </div>
  );
}

// ── Segmented control ───────────────────────────────────────────────────────
export interface SegmentOption<T extends string> {
  id: T;
  label: ReactNode;
  title?: string;
}

const SEG_TRACK_STYLE: CSSProperties = {
  display: 'flex', gap: 2, padding: 3, borderRadius: 'var(--settings-control-radius, 8px)',
  background: 'var(--material-inset-bg)', border: '1px solid var(--proto-line-2)', flex: 'none',
};

function segOptionStyle(active: boolean, inert: boolean): CSSProperties {
  return {
    minHeight: 'var(--settings-control-height, 34px)', padding: '4px 10px', border: 0, borderRadius: 6,
    fontFamily: 'inherit', fontSize: 13, fontWeight: active ? 550 : 400,
    background: active ? 'var(--material-control-bg)' : 'transparent',
    boxShadow: active ? 'var(--material-control-shadow)' : 'none',
    color: active ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    cursor: inert ? 'default' : 'pointer', transition: 'background .12s, color .12s',
  };
}

/** The sheet's one segmented control: a recessed track holding a raised active option. Options are
 *  words in the UI face; the active one is lifted, not tinted. */
export function SSegmented<T extends string>({ value, options, onChange, dataAttr, ariaLabel }: {
  value: T;
  options: SegmentOption<T>[];
  onChange?: (value: T) => void;
  dataAttr?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="settings-segmented" role="group" aria-label={ariaLabel} style={SEG_TRACK_STYLE}>
      {options.map((option) => (
        <button
          className="settings-segment" key={option.id} type="button" aria-pressed={option.id === value} title={option.title}
          {...(dataAttr ? { [dataAttr]: option.id } : {})}
          onClick={onChange ? () => onChange(option.id) : undefined}
          style={segOptionStyle(option.id === value, !onChange)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ── Chips and pills ─────────────────────────────────────────────────────────
export type SPillTone = 'strong' | 'amber' | 'success' | 'danger' | 'neutral';

// `strong` marks the one that is current (the default model, the account in use, a built-in): the
// neutral tint with ink text — a stronger word, not an accent block. Colour stays for status.
const PILL_TONE: Record<SPillTone, CSSProperties> = {
  strong: { background: 'var(--proto-gray)', color: 'var(--proto-ink-3)' },
  amber: { background: 'var(--proto-amber-bg)', color: 'var(--proto-amber-fg)' },
  success: { background: 'var(--proto-success-bg)', color: 'color-mix(in srgb, var(--proto-success) 85%, var(--proto-ink))' },
  danger: { background: 'var(--proto-danger-bg)', color: 'var(--proto-danger)' },
  neutral: { background: 'var(--proto-gray)', color: 'var(--proto-muted)' },
};

/** The one badge shape in settings: a soft tinted capsule, never outlined, in the UI face. */
export function SPill({ tone = 'neutral', children, ...rest }: {
  tone?: SPillTone;
  children: ReactNode;
} & Record<string, unknown>) {
  return (
    <span {...rest} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
      fontSize: 11, fontWeight: 550, fontVariantNumeric: 'tabular-nums',
      lineHeight: 1.5, padding: '1px 7px', borderRadius: 'var(--r-pill)',
      whiteSpace: 'nowrap', ...PILL_TONE[tone],
    }}>
      {children}
    </span>
  );
}

/** A count beside a heading or a tab: a plain number, not a filled badge. `amber` is for a count
 *  of things that need the user (issues to fix); `quiet` is a plain tally. */
export function SCount({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'quiet' }) {
  return (
    <span style={{
      fontSize: 12, fontWeight: tone === 'amber' ? 600 : 500, fontVariantNumeric: 'tabular-nums', lineHeight: 1,
      color: tone === 'amber' ? 'var(--proto-amber-fg)' : 'var(--proto-muted-3)', flex: 'none',
    }}>
      {children}
    </span>
  );
}

// A pressed chip is the gray selected tint with ink text, the same as a selected row.
function chipStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    minHeight: 'var(--settings-control-height, 34px)', padding: '4px 10px', border: 0, borderRadius: 'var(--settings-control-radius, 8px)',
    fontFamily: 'inherit', fontSize: 13, fontWeight: active ? 600 : 500,
    background: active ? 'var(--proto-gray)' : 'var(--material-control-bg)',
    boxShadow: active ? 'inset 0 0 0 1px var(--proto-line-3)' : 'var(--material-control-shadow)',
    color: active ? 'var(--proto-ink)' : 'var(--proto-muted)',
    display: 'inline-flex', alignItems: 'center', gap: 5,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  };
}

/** A standalone filter chip with the same target height as a segment. */
export function SChip({ active, disabled, onClick, children, className, ...rest }: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
} & Record<string, unknown>) {
  return (
    <button {...rest} className={settingsClassName('settings-chip', className)} type="button" aria-pressed={Boolean(active)} disabled={disabled}
      onClick={onClick} style={chipStyle(Boolean(active), Boolean(disabled))}>
      {children}
    </button>
  );
}

// ── Select chip ─────────────────────────────────────────────────────────────
/** A compact value control with one boundary and a trailing menu caret. */
export function SSelectChip({ children, onClick, disabled, className, ...rest }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
} & Record<string, unknown>) {
  return (
    <button {...rest} className={settingsClassName('settings-select-chip', className)} type="button" disabled={disabled} onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 'var(--settings-control-height, 34px)',
      padding: '4px 10px', border: '1px solid var(--settings-control-boundary, var(--proto-faint))', borderRadius: 'var(--settings-control-radius, 8px)',
      background: 'var(--settings-control-fill, var(--material-control-bg))', boxShadow: 'var(--material-control-shadow)',
      fontFamily: 'inherit', fontSize: 13, color: 'var(--proto-ink)', flex: 'none',
      cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
    }}>
      {children}
      <span style={{ color: 'var(--proto-muted-3)', fontSize: 10 }}>▾</span>
    </button>
  );
}

// ── Notices ─────────────────────────────────────────────────────────────────
export type SNoticeTone = 'amber' | 'danger' | 'accent' | 'muted';

const NOTICE_TONE: Record<SNoticeTone, { bg: string; fg: string; ring: string }> = {
  amber: { bg: 'var(--proto-amber-bg)', fg: 'var(--proto-amber-fg)', ring: 'var(--proto-amber-border)' },
  danger: { bg: 'var(--proto-danger-bg)', fg: 'var(--proto-danger)', ring: 'var(--proto-danger-bg)' },
  accent: { bg: 'var(--proto-accent-bg)', fg: 'var(--proto-accent)', ring: 'var(--proto-accent-border)' },
  muted: { bg: 'var(--proto-alt)', fg: 'var(--proto-muted)', ring: 'var(--proto-line-2)' },
};

/** An inline advisory strip. One shape, four tones — the tone is the whole message. */
export function SNotice({ tone = 'muted', icon, action, children, className, ...rest }: {
  tone?: SNoticeTone;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
} & Record<string, unknown>) {
  const spec = NOTICE_TONE[tone];
  return (
    <div {...rest} className={settingsClassName('settings-notice', className)} style={{
      display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: '12px 16px',
      borderRadius: 'var(--settings-card-radius, 12px)', background: spec.bg,
      border: `1px solid ${spec.ring}`, fontSize: 13, lineHeight: 1.6, color: spec.fg,
    }}>
      {icon}
      <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</span>
      {action}
    </div>
  );
}

/** The dot an attention notice leads with. */
export function SDot({ color = 'var(--proto-amber)', size = 8 }: {
  color?: string;
  size?: number;
}) {
  return (
    <span style={{ width: size, height: size, borderRadius: '50%', background: color, flex: 'none' }} />
  );
}

// ── Text action ─────────────────────────────────────────────────────────────
/** The accent text action a section heading or a stat card ends with. */
export function SLinkAction({ onClick, tone = 'accent', disabled, children, className, ...rest }: {
  onClick?: () => void;
  tone?: 'accent' | 'danger' | 'muted';
  disabled?: boolean;
  children: ReactNode;
} & Record<string, unknown>) {
  const [hover, setHover] = useState(false);
  const color = tone === 'danger' ? 'var(--proto-danger)'
    : tone === 'muted' ? 'var(--proto-muted-2)' : 'var(--proto-accent)';
  return (
    <button {...rest} className={settingsClassName('settings-link-action', className)} type="button" disabled={disabled} onClick={onClick}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        border: 0, background: 'transparent', padding: 0, fontFamily: 'inherit',
        fontSize: 12, fontWeight: 600, color, flex: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
        textDecoration: hover && !disabled ? 'underline' : 'none',
      }}>
      {children}
    </button>
  );
}

// ── Meter ───────────────────────────────────────────────────────────────────
/** A spend/quota bar. The track is a line tint so it reads as recessed on glass. An optional
 *  marker draws a thin tick at a percentage, e.g. where a limit kicks in. */
export function SMeter({ percent, tone = 'var(--proto-accent)', height = 6, marker }: {
  percent: number;
  tone?: string;
  height?: number;
  marker?: number;
}) {
  const width = Math.max(0, Math.min(100, percent));
  const track = (
    <div style={{ height, borderRadius: 'var(--r-pill)', background: 'var(--proto-line)', overflow: 'hidden' }}>
      <div style={{ width: `${width}%`, height: '100%', borderRadius: 'var(--r-pill)', background: tone, transition: 'width .2s' }} />
    </div>
  );
  if (marker == null) return track;
  return (
    <div style={{ position: 'relative' }}>
      {track}
      <span data-meter-marker aria-hidden="true" style={{
        position: 'absolute', top: -2, bottom: -2, width: 2, borderRadius: 1,
        left: `calc(${Math.max(0, Math.min(100, marker))}% - 1px)`, background: 'var(--proto-muted-2)', opacity: 0.7,
      }} />
    </div>
  );
}

// ── Entity row ──────────────────────────────────────────────────────────────
/** A standalone card for one entity in a list: status dot, name over a meta line, trailing controls.
 *  The meta line is UI face with tabular figures; `metaCode` sets it in the code face for a line
 *  that is literal config (an API id, a URL), and a caller can wrap a single path in `SCode`. */
export function SEntityRow({ dot, name, meta, metaCode, trailing, dim, onClick, className, ...rest }: {
  dot?: ReactNode;
  name: ReactNode;
  meta?: ReactNode;
  metaCode?: boolean;
  trailing?: ReactNode;
  dim?: boolean;
  onClick?: () => void;
} & Record<string, unknown>) {
  return (
    <div {...rest} className={settingsClassName('settings-entity-row', className)} role={onClick ? 'button' : undefined} onClick={onClick} style={{
      ...GROUP_STYLE, flexDirection: 'row', alignItems: 'center', gap: 12,
      padding: '12px 16px', opacity: dim ? 0.55 : 1,
      cursor: onClick ? 'pointer' : undefined,
    }}>
      {dot}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>{name}</div>
        {meta != null && (
          <div style={{ fontSize: 12, fontFamily: metaCode ? MONO : undefined, fontVariantNumeric: 'tabular-nums',
            color: 'var(--proto-muted-2)', marginTop: 4, overflowWrap: 'anywhere' }}>
            {meta}
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
}

/** An inline run of code (a path, a command) inside a UI-face line. */
export function SCode({ children }: { children: ReactNode }) {
  return <span style={{ fontFamily: MONO }}>{children}</span>;
}

/** The 13px/600 name an entity row leads with. */
export function SEntityName({ children }: { children: ReactNode }) {
  return <span className="settings-entity-name" style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{children}</span>;
}

// ── Stat ────────────────────────────────────────────────────────────────────
/** A headline number over its meter: the shape budget and usage both report in. */
export function SStat({ value, caption, action, percent, tone, marker, footnote }: {
  value: ReactNode;
  caption?: ReactNode;
  action?: ReactNode;
  percent?: number;
  tone?: string;
  marker?: number;
  footnote?: ReactNode;
}) {
  return (
    <div className="settings-stat" style={{ ...GROUP_STYLE, padding: '12px 16px' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 20, fontWeight: 550, fontVariantNumeric: 'tabular-nums', color: 'var(--proto-ink)' }}>{value}</span>
        {caption != null && <span style={{ fontSize: 12, color: 'var(--proto-muted-2)' }}>{caption}</span>}
        {action != null && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      {percent != null && <div style={{ marginTop: 12 }}><SMeter percent={percent} tone={tone} marker={marker} /></div>}
      {footnote != null && (
        <div style={{ marginTop: 12, fontSize: 12, lineHeight: 1.6, color: 'var(--proto-muted-2)' }}>{footnote}</div>
      )}
    </div>
  );
}
