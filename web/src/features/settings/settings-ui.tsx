// input:  react, theme tokens, settings-kit
// output: settings form atoms — card, field row, control, button, toggle
// pos:    Form-side primitives for the settings sheet; layout lives in settings-kit
// >>> Once updated, update this header and parent AGENTS.md <<<

import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

export * from './settings-kit';

const MONO = "'IBM Plex Mono',monospace";

// Raised glass: settings cards sit still inside the settings sheet, so `--glass-2` composites over
// the blur that sheet already produced. No filter of its own — the fill is a plain alpha blend. The
// outline is a shadow ring rather than a border, because a border is laid out and a ring is not:
// on glass the extra pixel shows up as a seam wherever two cards meet.
export const CARD_STYLE: CSSProperties = {
  background: 'var(--glass-2)',
  borderRadius: 'var(--r-card)',
  boxShadow: 'var(--shadow-card-subtle), 0 0 0 1px var(--proto-line-2)',
};

// Rest props are forwarded so callers can hang `data-*` hooks off the card. TypeScript does not
// type-check hyphenated JSX attributes, so without this they would be dropped silently.
export function SCard({
  children,
  style,
  ...rest
}: { children: ReactNode; style?: CSSProperties } & Record<string, unknown>) {
  return <div {...rest} style={{ ...CARD_STYLE, ...style }}>{children}</div>;
}

// The header reads at the same 13px/600 as a row title: a card header IS a row, just one that
// happens to name the rows below it. `right` keeps its mono styling only when it is plain text —
// an element is placed as-is so callers can hang a button or a pill there.
export function SCardHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  const plain = typeof right === 'string' || typeof right === 'number';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 16px',
        borderBottom: '1px solid var(--proto-line-2)',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--proto-ink)' }}>{title}</span>
      {right != null ? (
        <span style={{ marginLeft: 'auto', font: plain ? `400 10.5px ${MONO}` : undefined, color: plain ? 'var(--proto-muted-3)' : undefined }}>{right}</span>
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

function toggleCursor(interactive: boolean, inert?: boolean): CSSProperties['cursor'] {
  if (interactive) return 'pointer';
  if (inert) return 'not-allowed';
  return 'default';
}

function toggleVisualState(on: boolean, inert?: boolean): CSSProperties {
  return {
    // Off is `--proto-line-3`, not `--proto-line`: the track has to stay visible as a shape on a
    // translucent card, where the fainter tint disappears into the pane.
    background: on ? 'var(--proto-accent)' : 'var(--proto-line-3)',
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
    width: 36, height: 22, borderRadius: 'var(--r-pill)', position: 'relative',
    boxSizing: 'border-box', transition: 'background-color .15s',
    cursor: toggleCursor(interactive, inert), flex: 'none',
    boxShadow: focusShadow(focused), ...toggleVisualState(on, inert),
  };
}

// The knob slides on `left` rather than riding a flex alignment, so the travel is animatable.
function knobStyle(on: boolean): CSSProperties {
  return {
    position: 'absolute', top: 3, left: on ? 17 : 3, width: 16, height: 16,
    borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,.25)',
    transition: 'left .15s',
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
      <span style={knobStyle(props.on)} />
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
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: '.07em',
        color: 'var(--proto-muted)',
        textTransform: 'uppercase',
        margin: '16px 0 8px',
      }}
    >
      {children}
    </div>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span style={{ width: 96, flex: 'none', fontSize: 11.5, fontWeight: 600,
      color: 'var(--proto-muted)', paddingTop: 7 }}>
      {children}
    </span>
  );
}

function FieldHint(props: { hint?: ReactNode; tone?: 'muted' | 'danger' }) {
  if (props.hint == null) return null;
  const color = props.tone === 'danger' ? 'var(--proto-danger)' : 'var(--proto-muted-2)';
  return <div style={{ fontSize: 11, lineHeight: 1.6, marginTop: 4, color }}>{props.hint}</div>;
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
  font: `400 11.5px ${MONO}`,
  color: 'var(--proto-ink)',
  // Opaque, deliberately: a field you type into is the contract case for `--proto-card`. Text you
  // are editing must not have the mesh showing through it. The outline is still a ring, so the
  // field lines up with the ringed cards around it instead of sitting one pixel wider.
  background: 'var(--proto-card)',
  border: 0,
  boxShadow: '0 0 0 1px var(--proto-line-3)',
  borderRadius: 'var(--r-control)',
  padding: '7px 11px',
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
  // Only `accent` glows: `danger` is filled from the state palette rather than the accent, so a
  // glow there would read as a second primary (same call as design/Button).
  accent: {
    base: {
      color: 'var(--ink-solid-fg)', background: 'var(--proto-accent)',
      border: '1px solid transparent', boxShadow: 'var(--accent-glow)',
    },
    hover: { background: 'var(--proto-accent-strong)' },
  },
  danger: {
    base: { color: 'var(--proto-danger)', background: 'var(--glass-2)', border: 0, boxShadow: '0 0 0 1px var(--proto-danger-bg)' },
    hover: { background: 'var(--proto-danger-bg)' },
  },
  neutral: {
    base: { color: 'var(--proto-ink)', background: 'var(--glass-1)', border: 0, boxShadow: '0 0 0 1px var(--proto-line-3)' },
    hover: { background: 'var(--glass-2)' },
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
  // Compose rather than replace: the accent tone carries `--accent-glow` in its base shadow, and
  // overwriting it would make the primary button go flat for as long as it holds focus.
  const ring = '0 0 0 2px var(--proto-accent-bg)';
  return { ...style, boxShadow: style.boxShadow ? `${ring}, ${style.boxShadow}` : ring };
}

function buttonBaseStyle(
  tone: SButtonTone,
  disabled?: boolean,
  hover = false,
  focused = false,
): CSSProperties {
  const spec = BUTTON_TONE[tone];
  const base = { fontSize: 12, fontWeight: 600, borderRadius: 'var(--r-control)',
    padding: '7px 14px', flex: 'none', ...buttonDisabledStyle(disabled), ...spec.base };
  const hovered = hover && !disabled ? { ...base, ...spec.hover } : base;
  return focusedButtonStyle(hovered, focused, disabled);
}

type SButtonProps = {
  tone: SButtonTone;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  style?: CSSProperties;
} & Record<string, unknown>;

export function SButton({ tone, disabled, onClick, children, style, ...rest }: SButtonProps) {
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <button
      {...rest}
      type="button"
      disabled={Boolean(disabled)}
      aria-disabled={Boolean(disabled)}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{ fontFamily: 'inherit', ...buttonBaseStyle(tone, disabled, hover, focused), ...style }}
    >
      {children}
    </button>
  );
}
