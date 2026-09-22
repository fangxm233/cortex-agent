import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

// Side sheet built on Radix Dialog (same a11y guarantees as Modal: focus trap,
// esc, aria-modal, focus restore). `side` anchors the panel left or right and
// selects the matching slide animation. Token-only styling.
//
// The sheet is a floating glass surface: translucent `--glass-2` over its own `backdrop-filter`,
// lifted by `--shadow-float`. That shadow carries a hairline ring, so the old `border-l`/`border-r`
// seam is gone — a drawer over the backdrop is not a docked neighbour of anything.

const OVERLAY_CLASS =
  'fixed inset-0 z-40 bg-state-ink/40 ' +
  'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out ' +
  'motion-reduce:animate-none';

const SIDE_CLASS = {
  right: 'right-0 data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right',
  left: 'left-0 data-[state=open]:animate-slide-in-left data-[state=closed]:animate-slide-out-left',
} as const;

export type DrawerSide = keyof typeof SIDE_CLASS;

export interface DrawerProps {
  title: ReactNode;
  description?: ReactNode;
  hideTitle?: boolean;
  side?: DrawerSide;
  children?: ReactNode;
  footer?: ReactNode;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Drawer({
  title,
  description,
  hideTitle,
  side = 'right',
  children,
  footer,
  trigger,
  open,
  onOpenChange,
}: DrawerProps) {
  // `backdrop-filter` belongs here and only here in this file: the sheet is a single floating
  // overlay that does not move once open, so the blur is read once rather than per scroll frame.
  // The body below scrolls INSIDE it and stays unfiltered.
  const contentClass =
    'fixed inset-y-0 z-50 flex h-full w-[92vw] max-w-md flex-col gap-2g ' +
    'rounded-[var(--r-float)] bg-[var(--glass-2)] ' +
    '[backdrop-filter:var(--glass-filter)] [-webkit-backdrop-filter:var(--glass-filter)] ' +
    'p-3g shadow-[shadow:var(--shadow-float)] focus:outline-none ' +
    'motion-reduce:animate-none ' +
    SIDE_CLASS[side];

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY_CLASS} />
        <RadixDialog.Content className={contentClass}>
          <div className="flex items-start justify-between gap-2g">
            <RadixDialog.Title
              className={hideTitle ? 'sr-only' : 'text-body font-medium text-state-ink'}
            >
              {title}
            </RadixDialog.Title>
            <RadixDialog.Close
              aria-label="Close"
              className="-mr-1g -mt-1g rounded-[var(--r-control)] p-0.5g text-ui text-state-ink/60 transition-colors hover:bg-surface-canvas-alt hover:text-state-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
            >
              ✕
            </RadixDialog.Close>
          </div>
          {description ? (
            <RadixDialog.Description className="text-ui text-state-ink/70">
              {description}
            </RadixDialog.Description>
          ) : null}
          {children ? (
            <div className="flex-1 overflow-y-auto text-ui text-state-ink/80">{children}</div>
          ) : null}
          {footer ? <div className="flex items-center justify-end gap-1g pt-1g">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DrawerClose = RadixDialog.Close;
