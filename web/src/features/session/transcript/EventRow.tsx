import type { CSSProperties, ReactNode } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';

// The transcript's one quiet line: a 16px icon column, a label, a clipped summary and right-aligned
// meta. Everything that is not prose or a card the reader must act on — a turn's work, a tool run,
// a thought, a subagent, a resolved plan, a worker started, a system hint — is drawn with it, so the
// stream reads as answers with a few lines of record between them rather than a dozen kinds of chrome.
// No border and no fill: a hover tint is the only surface it ever shows.

export type EventIconName =
  | 'chevron' | 'check' | 'cross' | 'terminal' | 'file' | 'pencil' | 'search' | 'globe' | 'list'
  | 'layers' | 'diamond' | 'hourglass' | 'reply' | 'arrow' | 'circle' | 'spark';

const PATHS: Record<EventIconName, ReactNode> = {
  chevron: <path d="m6 4 4 4-4 4" />,
  check: <path d="m3.5 8.5 3 3 6-7" />,
  cross: <path d="m4.5 4.5 7 7m0-7-7 7" />,
  terminal: <path d="m3.5 5 3 3-3 3M8.5 11.5h4" />,
  file: <><path d="M4 2.5h5l3 3v8H4z" /><path d="M9 2.5v3h3" /></>,
  pencil: <path d="M3 13l1-3.5 6.5-6.5 2.5 2.5L6.5 12z" />,
  search: <><circle cx="7" cy="7" r="4" /><path d="m10 10 3.5 3.5" /></>,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.4 3.4 2.4 5.5S9.6 11.9 8 13.5C6.4 11.9 5.6 10.1 5.6 8S6.4 4.1 8 2.5z" /></>,
  list: <path d="M6 4.5h7M6 8h7M6 11.5h7M3 4.5h.01M3 8h.01M3 11.5h.01" />,
  layers: <><path d="M8 2.5 13.5 5.5 8 8.5 2.5 5.5z" /><path d="M2.5 8.5 8 11.5l5.5-3" /></>,
  diamond: <path d="M8 2.5 13.5 8 8 13.5 2.5 8z" />,
  hourglass: <path d="M4.5 2.5h7M4.5 13.5h7M5 2.5c0 3 6 3.5 6 5.5s-6 2.5-6 5.5M11 2.5c0 3-6 3.5-6 5.5s6 2.5 6 5.5" />,
  reply: <path d="M4 3v4.5a2 2 0 0 0 2 2h6.5M9.5 7 12.5 9.5 9.5 12" />,
  arrow: <path d="M5 11 11 5M6 5h5v5" />,
  circle: <circle cx="8" cy="8" r="4.5" />,
  spark: <path d="M8 2.5v3M8 10.5v3M2.5 8h3M10.5 8h3M4.2 4.2l2 2M9.8 9.8l2 2M11.8 4.2l-2 2M6.2 9.8l-2 2" />,
};

export function EventIcon({ name, open = false, color, size = 13 }: {
  name: EventIconName;
  /** chevron only: points down when open. */
  open?: boolean;
  color?: string;
  size?: number;
}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color ?? 'currentColor'} strokeWidth={1.7}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={name === 'chevron' ? { transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 140ms ease' } : undefined}>
      {PATHS[name]}
    </svg>
  );
}

/** A live state's dot: accent, with the soft ring the roster uses for a running worker. */
export function PulseDot({ color = 'var(--proto-accent)', still = false }: { color?: string; still?: boolean }): JSX.Element {
  return (
    <span aria-hidden="true" style={{
      width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none',
      ...(still ? {} : { animation: 'cxring 1.8s ease-out infinite' }),
    }} />
  );
}

export interface EventRowProps {
  icon: ReactNode;
  label?: ReactNode;
  summary?: ReactNode;
  meta?: ReactNode;
  /** Defined → the row is a disclosure button carrying `aria-expanded`. */
  expanded?: boolean;
  onClick?: () => void;
  /** Mobile: a finger-sized row with no hover tint. */
  touch?: boolean;
  title?: string;
  ariaLabel?: string;
  /** Written to the backend but not read by the model yet. */
  pending?: boolean;
  labelInk?: string;
  /** Extra attributes for tests and styling hooks (`data-*`). */
  attrs?: Record<string, string | boolean | undefined>;
  style?: CSSProperties;
}

const ICON_BOX: CSSProperties = { width: 16, height: 16, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--proto-faint)' };
const SUMMARY: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

export function eventRowStyle(touch: boolean, clickable: boolean): CSSProperties {
  return {
    display: 'flex', alignItems: 'center', gap: touch ? 9 : 10, minWidth: 0,
    width: 'calc(100% + 16px)', boxSizing: 'border-box', margin: '0 -8px', padding: '0 8px',
    minHeight: touch ? 40 : 30, border: 0, borderRadius: 8, background: 'transparent',
    font: 'inherit', fontSize: touch ? 13.5 : 13, lineHeight: 1.45, color: 'var(--proto-muted)', textAlign: 'left',
    cursor: clickable ? 'pointer' : 'default',
  };
}

export function EventRow({ icon, label, summary, meta, expanded, onClick, touch = false, title, ariaLabel, pending, labelInk, attrs, style }: EventRowProps): JSX.Element {
  const clickable = !!onClick;
  const content = (
    <>
      <span style={ICON_BOX}>{icon}</span>
      {label != null && <span style={{ color: labelInk ?? 'var(--proto-ink-3)', fontWeight: 550, flex: 'none', maxWidth: '60%', ...SUMMARY }}>{label}</span>}
      {summary != null && summary !== '' && <span style={SUMMARY}>{summary}</span>}
      {meta != null && <span style={{ marginLeft: 'auto', paddingLeft: 12, flex: 'none', fontSize: 12, color: 'var(--proto-faint)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>{meta}</span>}
    </>
  );
  const base = { ...eventRowStyle(touch, clickable), ...(pending ? { opacity: 0.55 } : {}), ...style };
  if (!clickable) return <div {...attrs} title={title} style={base}>{content}</div>;
  return (
    <button type="button" {...attrs} className={`${MENU_FOCUS}${touch ? '' : ' hover:bg-[var(--proto-gray)]'}`}
      aria-expanded={expanded} aria-label={ariaLabel} title={title} onClick={onClick} style={base}>
      {content}
    </button>
  );
}
