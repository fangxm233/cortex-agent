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
// box-shadow composed with `--tw-ring-shadow`, so the focus ring below still draws over the glow.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-state-run text-surface-card shadow-[shadow:var(--accent-glow)] hover:bg-state-run/90',
  secondary: 'border border-card bg-surface-card text-state-ink hover:bg-surface-canvas-alt',
  ghost: 'text-state-ink/80 hover:bg-surface-canvas-alt',
  danger: 'bg-state-fail text-surface-card hover:bg-state-fail/90',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-1g py-0.5g text-ui',
  md: 'px-2g py-1g text-ui',
};

const BASE =
  'inline-flex items-center justify-center gap-1g rounded-[var(--r-control)] font-medium transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40 ' +
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
