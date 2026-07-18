import type { CSSProperties, ReactNode } from 'react';

// Small 1:1 building blocks shared by the settings panels — the prototype's white card chrome,
// card header, mono key/value row, toggle and radio. Raw inline styles/px/hex per §8.3 (the light
// settings palette var(--proto-line)/var(--proto-line-2)/var(--proto-alt) is not all in proto.* tokens; the 1:1 rebuild uses exact
// values, matching the LeftRail / exec-drawer precedent).

const MONO = "'IBM Plex Mono',monospace";

export const CARD_STYLE: CSSProperties = {
  background: 'var(--proto-card)',
  border: '1px solid var(--proto-line)',
  borderRadius: 10,
  boxShadow: '0 1px 2px rgba(16,24,40,.03)',
};

export function SCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...CARD_STYLE, ...style }}>{children}</div>;
}

export function SCardHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '10px 14px',
        borderBottom: '1px solid var(--proto-line-2)',
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--proto-ink)' }}>{title}</span>
      {right != null ? (
        <span
          style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}
        >
          {right}
        </span>
      ) : null}
    </div>
  );
}

/** A mono key (muted) + right-aligned value row, as used in the Platform / Daemon cards. */
export function MonoKV({ k, value, valueColor }: { k: string; value: ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: 'flex' }}>
      <span style={{ color: 'var(--proto-muted-3)' }}>{k}</span>
      <span style={{ marginLeft: 'auto', color: valueColor }}>{value}</span>
    </div>
  );
}

/**
 * Prototype pill toggle (32×19). `on` reflects state; `onClick` optional. When there is no backend
 * op the toggle is inert (no onClick) and shows a not-wired cursor via `inert`.
 */
export function Toggle({ on, onClick, inert }: { on: boolean; onClick?: () => void; inert?: boolean }) {
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      style={{
        width: 32,
        height: 19,
        borderRadius: 999,
        background: on ? 'var(--proto-accent)' : 'var(--proto-line)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: on ? 'flex-end' : 'flex-start',
        padding: 2,
        boxSizing: 'border-box',
        cursor: onClick ? 'pointer' : inert ? 'not-allowed' : 'default',
        flex: 'none',
        opacity: inert ? 0.85 : 1,
      }}
    >
      <span style={{ width: 15, height: 15, borderRadius: '50%', background: 'var(--proto-card)' }} />
    </div>
  );
}

/** Prototype radio dot (14px) — selected = thick accent ring, unselected = thin gray ring. */
export function RadioDot({ selected }: { selected: boolean }) {
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: '50%',
        border: selected ? '4.5px solid var(--proto-accent)' : '1.5px solid var(--proto-line-3)',
        boxSizing: 'border-box',
        flex: 'none',
        marginTop: 1,
      }}
    />
  );
}
