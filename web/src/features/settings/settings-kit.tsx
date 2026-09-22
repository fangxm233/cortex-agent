// input:  react, theme tokens
// output: the settings row/card/control language shared by every panel
// pos:    Prototype-faithful primitives for the settings sheet
// >>> Once updated, update this header and parent AGENTS.md <<<

import { useState, type CSSProperties, type ReactNode } from 'react';

const MONO = "'IBM Plex Mono',monospace";

// ── Grouped rows ────────────────────────────────────────────────────────────
// The sheet's unit of content is a card of hairline-separated rows, not a bordered box. The ring is
// a shadow rather than a border so the card keeps its exact geometry when it sits on glass — a real
// border would add a hard pixel that reads as a seam against the blur behind it.
export const GROUP_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  borderRadius: 'var(--r-card)',
  background: 'var(--glass-2)',
  boxShadow: 'var(--shadow-card-subtle), 0 0 0 1px var(--proto-line-2)',
  overflow: 'hidden',
};

function dividerStyle(last: boolean): CSSProperties {
  return last ? {} : { borderBottom: '1px solid var(--proto-line-2)' };
}

/** A card of rows. Children are separated by hairlines; the last one is flush with the card edge. */
export function SRowGroup({ children, style, ...rest }: {
  children: ReactNode;
  style?: CSSProperties;
} & Record<string, unknown>) {
  const items = Array.isArray(children) ? children.flat() : [children];
  const rows = items.filter((child) => child != null && child !== false);
  return (
    <div {...rest} style={{ ...GROUP_STYLE, ...style }}>
      {rows.map((child, index) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={index} style={dividerStyle(index === rows.length - 1)}>{child}</div>
      ))}
    </div>
  );
}

export const ROW_STYLE: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 14, padding: '13px 16px',
};

const ROW_TITLE_STYLE: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' };
const ROW_DESC_STYLE: CSSProperties = {
  fontSize: 11.5, color: 'var(--proto-muted-2)', marginTop: 2, lineHeight: 1.5,
};

/** Title (+ optional description) on the left, a control on the right. */
export function SRow({ title, desc, control, align = 'center', children, ...rest }: {
  title: ReactNode;
  desc?: ReactNode;
  control?: ReactNode;
  align?: CSSProperties['alignItems'];
  children?: ReactNode;
} & Record<string, unknown>) {
  return (
    <div {...rest} style={{ ...ROW_STYLE, alignItems: align }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={ROW_TITLE_STYLE}>{title}</div>
        {desc != null && <div style={ROW_DESC_STYLE}>{desc}</div>}
        {children}
      </div>
      {control}
    </div>
  );
}

// ── Section heading ─────────────────────────────────────────────────────────
const SECTION_LABEL_STYLE: CSSProperties = {
  fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase',
  color: 'var(--proto-muted)',
};

/** The uppercase label above a card, with an optional trailing action. */
export function SSection({ label, action, children }: {
  label: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 2px 8px' }}>
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
  display: 'flex', gap: 2, padding: 3, borderRadius: 'var(--r-control)',
  background: 'var(--proto-line-2)', flex: 'none',
};

function segOptionStyle(active: boolean, mono: boolean, inert: boolean): CSSProperties {
  return {
    height: 24, padding: '0 11px', border: 0, borderRadius: 'var(--r-chip)',
    font: mono ? `500 11px ${MONO}` : undefined,
    fontFamily: mono ? undefined : 'inherit',
    fontSize: mono ? undefined : 11.5, fontWeight: mono ? undefined : 600,
    background: active ? 'var(--glass-2)' : 'transparent',
    boxShadow: active ? 'var(--shadow-card-subtle)' : 'none',
    color: active ? 'var(--proto-ink)' : 'var(--proto-muted-2)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    cursor: inert ? 'default' : 'pointer', transition: 'background .12s, color .12s',
  };
}

/** The sheet's one segmented control: a recessed track holding a raised active option. */
export function SSegmented<T extends string>({ value, options, onChange, dataAttr, mono, ariaLabel }: {
  value: T;
  options: SegmentOption<T>[];
  onChange?: (value: T) => void;
  dataAttr?: string;
  mono?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div role="group" aria-label={ariaLabel} style={SEG_TRACK_STYLE}>
      {options.map((option) => (
        <button
          key={option.id} type="button" aria-pressed={option.id === value} title={option.title}
          {...(dataAttr ? { [dataAttr]: option.id } : {})}
          onClick={onChange ? () => onChange(option.id) : undefined}
          style={segOptionStyle(option.id === value, Boolean(mono), !onChange)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ── Chips and pills ─────────────────────────────────────────────────────────
export type SPillTone = 'accent' | 'amber' | 'success' | 'danger' | 'neutral';

const PILL_TONE: Record<SPillTone, CSSProperties> = {
  accent: { background: 'var(--proto-accent-bg)', color: 'var(--proto-accent)' },
  amber: { background: 'var(--proto-amber-bg)', color: 'var(--proto-amber-fg)' },
  success: { background: 'var(--proto-success-bg)', color: 'var(--proto-success)' },
  danger: { background: 'var(--proto-danger-bg)', color: 'var(--proto-danger)' },
  neutral: { background: 'var(--proto-gray)', color: 'var(--proto-muted)' },
};

/** The one badge shape in settings: a soft tinted capsule, never outlined. */
export function SPill({ tone = 'neutral', mono, children, ...rest }: {
  tone?: SPillTone;
  mono?: boolean;
  children: ReactNode;
} & Record<string, unknown>) {
  return (
    <span {...rest} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
      font: mono ? `600 9.5px ${MONO}` : undefined,
      fontSize: mono ? undefined : 10, fontWeight: mono ? undefined : 600,
      lineHeight: 1.5, padding: '1.5px 7px', borderRadius: 'var(--r-pill)',
      whiteSpace: 'nowrap', ...PILL_TONE[tone],
    }}>
      {children}
    </span>
  );
}

/** A count badge for the nav and for tab strips. */
export function SCount({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'accent' }) {
  return (
    <span style={{
      minWidth: 16, height: 16, padding: '0 5px', boxSizing: 'border-box',
      borderRadius: 'var(--r-pill)', font: `600 9.5px ${MONO}`, lineHeight: 1,
      background: tone === 'amber' ? 'var(--proto-amber)' : 'var(--proto-accent)',
      color: 'var(--ink-solid-fg)', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', flex: 'none',
    }}>
      {children}
    </span>
  );
}

function chipStyle(active: boolean, disabled: boolean): CSSProperties {
  return {
    height: 26, padding: '0 11px', border: 0, borderRadius: 'var(--r-chip)',
    fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
    background: active ? 'var(--proto-accent-bg)' : 'var(--proto-line-2)',
    color: active ? 'var(--proto-accent)' : 'var(--proto-muted)',
    display: 'inline-flex', alignItems: 'center', gap: 5,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
  };
}

/** A standalone filter chip — the same capsule as a segment, but outside a track. */
export function SChip({ active, disabled, onClick, children, ...rest }: {
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
} & Record<string, unknown>) {
  return (
    <button {...rest} type="button" aria-pressed={Boolean(active)} disabled={disabled}
      onClick={onClick} style={chipStyle(Boolean(active), Boolean(disabled))}>
      {children}
    </button>
  );
}

// ── Select chip ─────────────────────────────────────────────────────────────
/** The glass affordance a value opens a menu from: a ringed pill carrying a caret. */
export function SSelectChip({ children, onClick, disabled, ...rest }: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
} & Record<string, unknown>) {
  return (
    <button {...rest} type="button" disabled={disabled} onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 30,
      padding: '0 10px 0 12px', border: 0, borderRadius: 'var(--r-control)',
      background: 'var(--glass-1)', boxShadow: '0 0 0 1px var(--proto-line)',
      fontFamily: 'inherit', fontSize: 12.5, color: 'var(--proto-ink)', flex: 'none',
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
export function SNotice({ tone = 'muted', icon, action, children, ...rest }: {
  tone?: SNoticeTone;
  icon?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
} & Record<string, unknown>) {
  const spec = NOTICE_TONE[tone];
  return (
    <div {...rest} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
      borderRadius: 'var(--r-card)', background: spec.bg,
      boxShadow: `0 0 0 1px ${spec.ring}`, fontSize: 12.5, lineHeight: 1.6, color: spec.fg,
    }}>
      {icon}
      <span style={{ flex: 1, minWidth: 0 }}>{children}</span>
      {action}
    </div>
  );
}

/** The pulsing dot an attention notice leads with. */
export function SDot({ color = 'var(--proto-amber)', pulse, size = 8 }: {
  color?: string;
  pulse?: boolean;
  size?: number;
}) {
  return (
    <span className={pulse ? 'animate-cxpulse motion-reduce:animate-none' : undefined}
      style={{ width: size, height: size, borderRadius: '50%', background: color, flex: 'none' }} />
  );
}

// ── Text action ─────────────────────────────────────────────────────────────
/** The accent text action a section heading or a stat card ends with. */
export function SLinkAction({ onClick, tone = 'accent', disabled, children, ...rest }: {
  onClick?: () => void;
  tone?: 'accent' | 'danger' | 'muted';
  disabled?: boolean;
  children: ReactNode;
} & Record<string, unknown>) {
  const [hover, setHover] = useState(false);
  const color = tone === 'danger' ? 'var(--proto-danger)'
    : tone === 'muted' ? 'var(--proto-muted-2)' : 'var(--proto-accent)';
  return (
    <button {...rest} type="button" disabled={disabled} onClick={onClick}
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
/** A spend/quota bar. The track is a line tint so it reads as recessed on glass. */
export function SMeter({ percent, tone = 'var(--proto-accent)', height = 6 }: {
  percent: number;
  tone?: string;
  height?: number;
}) {
  const width = Math.max(0, Math.min(100, percent));
  return (
    <div style={{ height, borderRadius: 'var(--r-pill)', background: 'var(--proto-line)', overflow: 'hidden' }}>
      <div style={{ width: `${width}%`, height: '100%', borderRadius: 'var(--r-pill)', background: tone, transition: 'width .2s' }} />
    </div>
  );
}

// ── Key cap ─────────────────────────────────────────────────────────────────
/** A keyboard key, rendered as a ringed mono cap. */
export function SKeyCap({ children }: { children: ReactNode }) {
  return (
    <span style={{
      font: `500 11px ${MONO}`, color: 'var(--proto-ink)', background: 'var(--glass-1)',
      boxShadow: '0 0 0 1px var(--proto-line-3)', borderRadius: 'var(--r-chip)',
      padding: '2px 8px', flex: 'none', whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

// ── Entity row ──────────────────────────────────────────────────────────────
/** A standalone card for one entity in a list: status dot, name over mono meta, trailing controls. */
export function SEntityRow({ dot, name, meta, trailing, dim, onClick, ...rest }: {
  dot?: ReactNode;
  name: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  dim?: boolean;
  onClick?: () => void;
} & Record<string, unknown>) {
  return (
    <div {...rest} role={onClick ? 'button' : undefined} onClick={onClick} style={{
      ...GROUP_STYLE, flexDirection: 'row', alignItems: 'center', gap: 12,
      padding: '12px 16px', opacity: dim ? 0.55 : 1,
      cursor: onClick ? 'pointer' : undefined,
    }}>
      {dot}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{name}</div>
        {meta != null && (
          <div style={{ font: `400 10.5px ${MONO}`, color: 'var(--proto-muted-3)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {meta}
          </div>
        )}
      </div>
      {trailing}
    </div>
  );
}

/** The 13px/600 name an entity row leads with. */
export function SEntityName({ children }: { children: ReactNode }) {
  return <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{children}</span>;
}

// ── Stat ────────────────────────────────────────────────────────────────────
/** A headline number over its meter: the shape budget and usage both report in. */
export function SStat({ value, caption, action, percent, tone, footnote }: {
  value: ReactNode;
  caption?: ReactNode;
  action?: ReactNode;
  percent?: number;
  tone?: string;
  footnote?: ReactNode;
}) {
  return (
    <div style={{ ...GROUP_STYLE, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ font: `500 20px ${MONO}`, color: 'var(--proto-ink)' }}>{value}</span>
        {caption != null && <span style={{ fontSize: 12, color: 'var(--proto-muted-2)' }}>{caption}</span>}
        {action != null && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </div>
      {percent != null && <div style={{ marginTop: 12 }}><SMeter percent={percent} tone={tone} /></div>}
      {footnote != null && (
        <div style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.6, color: 'var(--proto-muted-2)' }}>{footnote}</div>
      )}
    </div>
  );
}
