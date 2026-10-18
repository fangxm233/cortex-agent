import { forwardRef, type ButtonHTMLAttributes } from 'react';

// Button primitive with token-driven variants (design §5). No hard-coded hex —
// colors come from the state palette / surface tokens. Forwards its ref so it can
// be an `asChild` Radix trigger (Dialog/Popover restore focus via the trigger ref).

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
export type ButtonSize = 'sm' | 'md';

// `primary` is ink, not accent: the accent is reserved for state (running, selected, a link), so
// a filled accent button would compete with the thing it acts on. Ink also inverts cleanly in the
// dark theme through the `--ink-solid-*` pair. Keyboard focus uses the shared solid outline.
const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: '[background:var(--ink-solid-bg)] text-[var(--ink-solid-fg)] hover:opacity-90',
  // A hairline, the same weight as a field's ring: a secondary action should not out-draw the
  // inputs beside it.
  secondary: 'border border-proto-line-4 [background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] text-state-ink hover:[background:var(--material-inset-bg)]',
  ghost: 'text-proto-ink-2 hover:bg-surface-canvas-alt',
  danger: 'bg-state-fail text-[var(--ink-solid-fg)] hover:bg-state-fail/90',
  // The first step of a destructive pair: quiet until hovered, so the filled `danger` that arms
  // behind it is the only red block.
  'danger-outline': 'border border-proto-danger-bg [background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] text-proto-danger hover:[background:var(--proto-danger-bg)]',
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
