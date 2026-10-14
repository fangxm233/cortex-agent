import type { CSSProperties, ReactNode } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';

// One capsule in the chat's activity strip — the single line above the composer that stands in for
// the task list, waitpoints, team and board. A capsule only summarizes; what it opens holds the detail.

export type ActivityChipTone = 'plain' | 'ask';

function chipStyle(tone: ActivityChipTone, floating: boolean, grow: boolean, pressed: boolean): CSSProperties {
  const ask = tone === 'ask';
  const fill = floating
    ? { background: 'var(--glass-1)', backdropFilter: 'var(--glass-filter)', WebkitBackdropFilter: 'var(--glass-filter)' }
    : { background: pressed ? 'var(--proto-card)' : 'var(--material-card-bg)' };
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, height: floating ? 30 : 28, padding: '0 10px',
    flex: grow ? '0 1 auto' : 'none', minWidth: grow ? 0 : undefined, maxWidth: '100%', overflow: 'hidden',
    boxSizing: 'border-box', border: 0, borderRadius: 'var(--r-pill)', cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 12, whiteSpace: 'nowrap', textAlign: 'left', color: ask ? 'var(--proto-amber-fg)' : 'var(--proto-ink-2)',
    ...fill,
    ...(ask ? { background: 'var(--proto-amber-bg)' } : null),
    boxShadow: [
      `0 0 0 1px ${ask ? 'var(--proto-amber-border)' : pressed ? 'var(--proto-line-3)' : 'var(--proto-line)'}`,
      floating ? 'var(--shadow-chrome-float)' : null,
    ].filter(Boolean).join(', '),
  };
}

export function ActivityChip({ data, label, tone = 'plain', floating = false, grow = false, expanded, onClick, children }: {
  /** The chip's `data-activity-chip` value, for tests and styling hooks. */
  data: string;
  label: string;
  tone?: ActivityChipTone;
  /** Mobile: hangs over the scrolling transcript, so it takes the frosted chrome. */
  floating?: boolean;
  /** The one chip that carries text and gives way first when the row runs short. */
  grow?: boolean;
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button type="button" data-activity-chip={data} className={MENU_FOCUS} aria-label={label} title={label}
      aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); onClick(); }}
      style={chipStyle(tone, floating, grow, !!expanded)}>
      {children}
    </button>
  );
}

export const CHIP_COUNT: CSSProperties = { flex: 'none', font: "600 11px 'IBM Plex Mono',monospace" };
export const CHIP_TEXT: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' };
