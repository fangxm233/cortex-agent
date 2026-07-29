import { useState, type CSSProperties, type ReactNode } from 'react';

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

/** The uppercase section caption above a block of fields (TRIGGER / ACTION / SCOPE / ADVANCED). */
export function SSectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 9.5,
        fontWeight: 700,
        letterSpacing: '.06em',
        color: 'var(--proto-muted-3)',
        textTransform: 'uppercase',
        margin: '14px 0 7px',
      }}
    >
      {children}
    </div>
  );
}

/** A fixed-width mono label + a control, with an optional hint or error line underneath. */
export function SFieldRow({
  label,
  children,
  hint,
  hintTone,
}: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  hintTone?: 'muted' | 'danger';
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '4px 0' }}>
      <span
        style={{
          width: 92,
          flex: 'none',
          font: `400 10px ${MONO}`,
          color: 'var(--proto-muted-3)',
          paddingTop: 6,
        }}
      >
        {label}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {children}
        {hint != null ? (
          <div
            style={{
              fontSize: 9.5,
              lineHeight: 1.6,
              marginTop: 3,
              color: hintTone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-faint)',
            }}
          >
            {hint}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Shared text/number/select chrome so every settings control lines up. */
export const S_CONTROL_STYLE: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  font: `400 11px ${MONO}`,
  color: 'var(--proto-ink)',
  background: 'var(--proto-card)',
  border: '1px solid var(--proto-line)',
  borderRadius: 7,
  padding: '5px 9px',
  outline: 'none',
};

export const S_CONTROL_DISABLED_STYLE: CSSProperties = {
  ...S_CONTROL_STYLE,
  background: 'var(--proto-alt)',
  color: 'var(--proto-muted-2)',
  cursor: 'not-allowed',
};

export type SButtonTone = 'accent' | 'danger' | 'neutral';

const BUTTON_TONE: Record<SButtonTone, { base: CSSProperties; hover: CSSProperties }> = {
  accent: {
    base: { color: 'var(--ink-solid-fg)', background: 'var(--proto-accent)', border: '1px solid transparent' },
    hover: { background: 'var(--proto-accent-strong)' },
  },
  danger: {
    base: { color: 'var(--proto-danger)', background: 'var(--proto-card)', border: '1px solid var(--proto-danger-bg)' },
    hover: { background: 'var(--proto-danger-bg)' },
  },
  neutral: {
    base: { color: 'var(--proto-ink)', background: 'var(--proto-card)', border: '1px solid var(--proto-line-3)' },
    hover: { background: 'var(--proto-alt)' },
  },
};

/**
 * Footer action button. `disabled` keeps the control rendered (so its intent stays visible) but
 * removes the handler — the settings panels never hide an action the user is one state away from.
 */
export function SButton({
  tone,
  disabled,
  onClick,
  children,
  ...rest
}: {
  tone: SButtonTone;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
} & Record<string, unknown>) {
  const [hover, setHover] = useState(false);
  const spec = BUTTON_TONE[tone];
  const base: CSSProperties = {
    fontSize: 11.5,
    fontWeight: 600,
    borderRadius: 8,
    padding: '6px 14px',
    flex: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    ...spec.base,
  };
  return (
    <span
      {...rest}
      onClick={disabled ? undefined : onClick}
      role={disabled ? undefined : 'button'}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={hover && !disabled ? { ...base, ...spec.hover } : base}
    >
      {children}
    </span>
  );
}
