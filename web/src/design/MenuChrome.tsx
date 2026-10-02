import { useEffect, type CSSProperties, type ReactNode } from 'react';

// The chrome the composer's pickers share: one card, one row, one hover rule.
//
// The engine chip and the agent chip answer different questions and own different menus, but on
// screen they are the same object — a card of rows hanging off a 30px chip. Sharing the pieces is
// what stops the two from drifting into two menus that merely resemble each other.

// Only stationary overlay shells filter; rows and inner scrollers share the surface.
export const MENU_SURFACE: CSSProperties = {
  background: 'var(--material-overlay-bg)',
  boxShadow: 'var(--material-overlay-shadow)',
  backdropFilter: 'var(--glass-filter)',
  WebkitBackdropFilter: 'var(--glass-filter)',
};

export const MONO = "'IBM Plex Mono',monospace";
export const MENU_FOCUS = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--proto-accent)]';
export const MENU_BUTTON_STYLE = { width: '100%', border: 0, textAlign: 'left', fontFamily: 'inherit', borderRadius: 'var(--r-chip)' } as const;

/** Hover lives in the menu that owns the rows, so only one row anywhere is lit at a time. */
export interface HoverProps {
  hover: string | null;
  setHover: (value: string | null) => void;
}

export function rowBackground(id: string, hover: string | null, active: boolean): string {
  if (hover === id) return 'var(--proto-gray)';
  return active ? 'var(--proto-accent-bg)' : 'transparent';
}

/** A section heading: what the rows under it are choosing between. */
export function SectionTitle({ text }: { text: string }): JSX.Element {
  return (
    <div style={{
      font: `600 11px ${MONO}`, letterSpacing: '0.05em', textTransform: 'uppercase',
      color: 'var(--proto-muted)', padding: '6px 8px 3px',
    }}>
      {text}
    </div>
  );
}

/** A footer line: what the list did not draw, and why. */
export function Note({ text }: { text: string }): JSX.Element {
  return (
    <div style={{
      font: `400 11px ${MONO}`, color: 'var(--proto-muted)', padding: '5px 8px 6px', lineHeight: 1.5,
    }}>
      {text}
    </div>
  );
}

export function Divider(): JSX.Element {
  return <div style={{ height: 1, background: 'var(--proto-line)', margin: '5px 0' }} />;
}

/** One pickable row: what it is, what it is worth, and a tick when it is what runs now. */
export function MenuRow({
  id, label, sub, active, disabled = false, onPick, hover, setHover,
}: {
  id: string;
  label: string;
  sub?: string | null;
  active: boolean;
  /** Drawn but not clickable — see the agent menu, the one list short enough to say why. */
  disabled?: boolean;
  onPick: () => void;
} & HoverProps): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      className={MENU_FOCUS}
      onMouseEnter={() => setHover(disabled ? null : id)}
      onMouseLeave={() => setHover(hover === id ? null : hover)}
      onClick={(event) => { event.stopPropagation(); if (!disabled) onPick(); }}
      data-selection-row={id}
      data-disabled={disabled ? 'true' : undefined}
      style={{
        ...MENU_BUTTON_STYLE,
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px',
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.45 : 1,
        background: rowBackground(id, hover, active),
      }}
    >
      <span style={{ font: `600 11px ${MONO}`, color: 'var(--proto-ink)' }}>{label}</span>
      {sub ? <span style={{ font: `400 11px ${MONO}`, color: 'var(--proto-muted)' }}>{sub}</span> : null}
      {active && (
        <span style={{ marginLeft: 'auto', color: 'var(--proto-accent)', fontSize: 11, fontWeight: 700 }}>✓</span>
      )}
    </button>
  );
}

/** The card itself, anchored to its chip's `position: relative` box rather than to the viewport —
 *  the chip is inside a scrolling composer, and a fixed menu would part company with it. */
interface MenuCardProps {
  /** `data-menu` value — what tells one composer menu from another, in tests and in the DOM. */
  kind: string;
  /** `data-selection-level`, for a menu with levels. A flat list has none and draws no attribute. */
  level?: string;
  minWidth?: number;
  placement?: 'above' | 'below';
  align?: 'left' | 'right';
  className?: string;
  children: ReactNode;
}

export function MenuCard({ kind, level, minWidth = 244, placement = 'above', align = 'right', className, children }: MenuCardProps): JSX.Element {
  return (
    <div data-menu={kind} data-selection-level={level} className={className} style={{
      position: 'absolute',
      ...(align === 'right' ? { right: 0 } : { left: 0 }),
      ...(placement === 'above' ? { bottom: 36 } : { top: 36 }),
      ...MENU_SURFACE,
      border: '1px solid var(--proto-line)', borderRadius: 'var(--r-card)',
      zIndex: 59, minWidth, overflow: 'hidden',
    }}>
      <div data-menu-scroll style={{ maxHeight: 420, overflowY: 'auto' }}>{children}</div>
    </div>
  );
}

// While a picker is open, Escape runs `escape` and a click outside runs `close`. A menu with levels
// retreats one level on Escape (a sub-pane back to the root) and only closes at the root — the same
// thing the mobile sheet's hardware back does; a flat menu passes `close` for both. A click outside
// is unambiguous and always closes.
export function useDismissMenu(open: boolean, escape: () => void, close: () => void): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') escape(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', close);
    };
  }, [open, escape, close]);
}
