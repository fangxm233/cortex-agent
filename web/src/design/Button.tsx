// input:  React, theme tokens, shared focus-visible styles
// output: Button, ButtonProps, ButtonVariant, ButtonSize
// pos:    Unblurred material actions with semantic foregrounds
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { forwardRef, type ButtonHTMLAttributes } from 'react';

// Button primitive with token-driven variants (design §5). No hard-coded hex —
// colors come from the state palette / surface tokens. Forwards its ref so it can
// be an `asChild` Radix trigger (Dialog/Popover restore focus via the trigger ref).

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

// Only the accent-filled `primary` carries `--accent-glow`; `danger` is filled from the state
// palette, not the accent, so glowing it would read as a second primary.
// The glow needs the arbitrary shadow utility's `shadow:` type hint — a bare `var()` there is
// ambiguous and Tailwind compiles it to a shadow *color* instead. The hinted form also keeps the
// box-shadow composed with Tailwind shadows; keyboard focus uses the shared solid outline.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-state-run bg-[image:var(--material-sheen)] text-[var(--accent-fg)] shadow-[shadow:var(--accent-glow)] hover:bg-proto-accent-strong',
  secondary: 'border border-proto-faint [background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] text-state-ink hover:[background:var(--material-inset-bg)]',
  ghost: 'text-proto-ink-2 hover:bg-surface-canvas-alt',
  danger: 'bg-state-fail bg-[image:var(--material-sheen)] text-[var(--ink-solid-fg)] hover:bg-state-fail/90',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-1g py-0.5g text-ui',
  md: 'px-2g py-1g text-ui',
};

const BASE =
  'inline-flex items-center justify-center gap-1g rounded-[var(--r-control)] font-medium transition-colors ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={[BASE, VARIANT_CLASS[variant], SIZE_CLASS[size], className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    />
  );
});
