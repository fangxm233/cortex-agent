import { createContext, useContext, useState, type CSSProperties, type ReactNode } from 'react';
import { MENU_FOCUS } from '@/design/MenuChrome';

// One capsule in the chat's activity strip — the single line above the composer that stands in for
// the task list, waitpoints, team and board. A capsule only summarizes; what it opens holds the detail.
//
// It is also the ONE capsule of the desktop chat: the header's team and board capsules draw from the
// same `capsuleStyle`, so every persistent status pill reads as one object wherever it sits.

export type ActivityChipTone = 'plain' | 'ask';

/** The capsule itself: 28px, a hairline, a translucent card fill and a pill corner, the UI face with
 *  aligned digits. `lit` (hovered) takes the solid card; `pressed` (its popover is open) also firms
 *  up the hairline. Attention never fills it — whatever waits on the user says so with its own dot
 *  or count colour, so the capsule shape stays the same in every state. */
export function capsuleStyle({ lit = false, pressed = false }: { lit?: boolean; pressed?: boolean } = {}): CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 7, height: 28, padding: '0 11px', boxSizing: 'border-box',
    border: `1px solid ${pressed ? 'var(--proto-line-3)' : 'var(--proto-line)'}`, borderRadius: 'var(--r-pill)',
    background: lit || pressed ? 'var(--proto-card)' : 'color-mix(in srgb, var(--proto-card) 60%, transparent)',
    color: 'var(--proto-ink-2)', font: '400 12.5px/1.2 var(--font-ui)', fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap', textAlign: 'left', cursor: 'pointer',
  };
}

/** How much room the desktop chat header leaves its capsules. The header folds them as its pane
 *  narrows — the board to its flag and the count of what waits on the user, the team to its dots and
 *  a worker count — and says so here, so each capsule keeps its full words in its tooltip and label
 *  instead. Outside the header the capsules are always full. */
export interface HeaderCapsuleFit {
  board: 'full' | 'compact';
  team: 'full' | 'compact';
}
const FULL_FIT: HeaderCapsuleFit = { board: 'full', team: 'full' };
export const HeaderCapsuleFitContext = createContext<HeaderCapsuleFit>(FULL_FIT);
export function useHeaderCapsuleFit(): HeaderCapsuleFit {
  return useContext(HeaderCapsuleFitContext);
}

function chipStyle(tone: ActivityChipTone, floating: boolean, grow: number, pressed: boolean, lit: boolean): CSSProperties {
  const base = capsuleStyle({ lit, pressed });
  return {
    ...base,
    flex: grow ? `0 ${grow} auto` : 'none', minWidth: grow ? 0 : undefined, maxWidth: '100%', overflow: 'hidden',
    // An `ask` capsule (the phone's board, once something waits on the user) only turns its text and
    // count amber; the fill and hairline stay those of every other capsule.
    color: tone === 'ask' ? 'var(--proto-amber-fg)' : base.color,
    // Mobile hangs the strip over the scrolling transcript, so it takes the frosted chrome and a lift.
    ...(floating ? {
      height: 30, background: 'var(--glass-1)', backdropFilter: 'var(--glass-filter)',
      WebkitBackdropFilter: 'var(--glass-filter)', boxShadow: 'var(--shadow-chrome-float)',
    } : null),
  };
}

export function ActivityChip({ data, label, tone = 'plain', floating = false, grow = false, expanded, onClick, children }: {
  /** The chip's `data-activity-chip` value, for tests and styling hooks. */
  data: string;
  label: string;
  tone?: ActivityChipTone;
  /** Mobile: hangs over the scrolling transcript, so it takes the frosted chrome. */
  floating?: boolean;
  /** A chip that carries text and gives way when the row runs short. A number weights how much
   *  sooner it yields than a `true` (1) chip — the wait capsule gives way before the task's label. */
  grow?: boolean | number;
  expanded?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  const [hover, setHover] = useState(false);
  return (
    <button type="button" data-activity-chip={data} className={MENU_FOCUS} aria-label={label} title={label}
      aria-expanded={expanded} onClick={(event) => { event.stopPropagation(); onClick(); }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={chipStyle(tone, floating, grow === true ? 1 : grow || 0, !!expanded, hover)}>
      {children}
    </button>
  );
}

/** A count inside a capsule: a plain number in the UI face, never a filled badge. */
export const CHIP_COUNT: CSSProperties = { flex: 'none', fontWeight: 550, fontVariantNumeric: 'tabular-nums' };
export const CHIP_TEXT: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' };
