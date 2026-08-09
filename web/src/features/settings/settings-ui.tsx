// input:  settings card chrome and control props
// output: cards, rows, toggles, buttons, and radios
// pos:    Shared desktop settings primitives
// >>> 一旦我被更新，务必更新我的开头注释与所属文件夹 CORTEX.md <<<

import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

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
        <span style={{ marginLeft: 'auto', font: `400 9.5px ${MONO}`, color: 'var(--proto-muted-3)' }}>{right}</span>
      ) : null}
    </div>
  );
}

export function MonoKV({ k, value, valueColor }: { k: string; value: ReactNode; valueColor?: string }) {
  return (
    <div style={{ display: 'flex' }}>
      <span style={{ color: 'var(--proto-muted-3)' }}>{k}</span>
      <span style={{ marginLeft: 'auto', color: valueColor }}>{value}</span>
    </div>
  );
}

function isActionKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

export function onActionKey(event: ReactKeyboardEvent, onClick?: () => void): void {
  if (!onClick || !isActionKey(event.key)) return;
  event.preventDefault();
  onClick();
}

function interactiveButtonProps(onClick?: () => void) {
  if (!onClick) return {};
  return {
    role: 'button' as const,
    tabIndex: 0,
    onKeyDown: (event: ReactKeyboardEvent) => onActionKey(event, onClick),
  };
}

function toggleCursor(interactive: boolean, inert?: boolean): CSSProperties['cursor'] {
  if (interactive) return 'pointer';
  if (inert) return 'not-allowed';
  return 'default';
}

function toggleVisualState(on: boolean, inert?: boolean): CSSProperties {
  return {
    background: on ? 'var(--proto-accent)' : 'var(--proto-line)',
    justifyContent: on ? 'flex-end' : 'flex-start',
    opacity: inert ? 0.85 : 1,
  };
}

function focusShadow(focused: boolean): CSSProperties['boxShadow'] {
  return focused ? '0 0 0 2px var(--proto-accent-bg)' : undefined;
}

function toggleStyle(
  on: boolean,
  interactive: boolean,
  inert?: boolean,
  focused = false,
): CSSProperties {
  return {
    width: 32, height: 19, borderRadius: 999, display: 'flex',
    alignItems: 'center', padding: 2, boxSizing: 'border-box',
    cursor: toggleCursor(interactive, inert), flex: 'none',
    boxShadow: focusShadow(focused), ...toggleVisualState(on, inert),
  };
}

export function Toggle(props: {
  on: boolean;
  onClick?: () => void;
  inert?: boolean;
  ariaLabel?: string;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <div onClick={props.onClick} role="switch"
      tabIndex={props.onClick ? 0 : undefined}
      onKeyDown={props.onClick ? (event) => onActionKey(event, props.onClick) : undefined}
      aria-label={props.ariaLabel} aria-checked={props.on}
      aria-disabled={!props.onClick}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      style={toggleStyle(props.on, Boolean(props.onClick), props.inert, focused)}>
      <span style={{ width: 15, height: 15, borderRadius: '50%', background: 'var(--proto-card)' }} />
    </div>
  );
}

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

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{ width: 92, flex: 'none', font: `400 10px ${MONO}`,
      color: 'var(--proto-muted-3)', paddingTop: 6 }}>
      {children}
    </span>
  );
}

function FieldHint(props: { hint?: ReactNode; tone?: 'muted' | 'danger' }) {
  if (props.hint == null) return null;
  const color = props.tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-faint)';
  return <div style={{ fontSize: 9.5, lineHeight: 1.6, marginTop: 3, color }}>{props.hint}</div>;
}

export function SFieldRow(props: {
  label: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
  hintTone?: 'muted' | 'danger';
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '4px 0' }}>
      <FieldLabel>{props.label}</FieldLabel>
      <div style={{ flex: 1, minWidth: 0 }}>
        {props.children}
        <FieldHint hint={props.hint} tone={props.hintTone} />
      </div>
    </div>
  );
}

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

function buttonDisabledStyle(disabled?: boolean): CSSProperties {
  return {
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
  };
}

function focusedButtonStyle(
  style: CSSProperties,
  focused: boolean,
  disabled?: boolean,
): CSSProperties {
  if (!focused || disabled) return style;
  return { ...style, boxShadow: '0 0 0 2px var(--proto-accent-bg)' };
}

function buttonBaseStyle(
  tone: SButtonTone,
  disabled?: boolean,
  hover = false,
  focused = false,
): CSSProperties {
  const spec = BUTTON_TONE[tone];
  const base = { fontSize: 11.5, fontWeight: 600, borderRadius: 8,
    padding: '6px 14px', flex: 'none', ...buttonDisabledStyle(disabled), ...spec.base };
  const hovered = hover && !disabled ? { ...base, ...spec.hover } : base;
  return focusedButtonStyle(hovered, focused, disabled);
}

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
  const [focused, setFocused] = useState(false);
  const interactive = interactiveButtonProps(disabled ? undefined : onClick);
  return (
    <span
      {...rest}
      onClick={disabled ? undefined : onClick}
      {...interactive}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={buttonBaseStyle(tone, disabled, hover, focused)}
    >
      {children}
    </span>
  );
}
