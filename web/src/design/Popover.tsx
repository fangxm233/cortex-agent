import * as RadixPopover from '@radix-ui/react-popover';
import type { ReactNode } from 'react';

// Token-styled wrapper over Radix Popover (approved primitive layer, design §1):
// positioning, esc-to-close and focus return to the trigger come from Radix.
// Supports controlled (`open`/`onOpenChange`) and uncontrolled usage.
//
// The content is a floating glass sheet — `--glass-2` over its own `backdrop-filter`, `--shadow-float`
// for the lift and the hairline ring that replaces the old border. A popover is a small, static
// overlay, which is the only shape blur is affordable on.

const CONTENT_CLASS =
  'z-50 min-w-[12rem] rounded-[var(--r-float)] bg-[var(--glass-2)] ' +
  '[backdrop-filter:var(--glass-filter)] [-webkit-backdrop-filter:var(--glass-filter)] ' +
  'p-2g text-ui text-state-ink shadow-[shadow:var(--shadow-float)] ' +
  'focus:outline-none ' +
  'data-[state=open]:animate-popover-in data-[state=closed]:animate-popover-out ' +
  'motion-reduce:animate-none';

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  side?: RadixPopover.PopoverContentProps['side'];
  align?: RadixPopover.PopoverContentProps['align'];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({
  trigger,
  children,
  side = 'bottom',
  align = 'center',
  open,
  onOpenChange,
}: PopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{trigger}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content className={CONTENT_CLASS} side={side} align={align} sideOffset={6}>
          {children}
          {/* The arrow is an SVG and cannot carry `backdrop-filter`, so it matches the sheet's
              alpha instead of its opaque predecessor — otherwise it reads as a solid tab stuck to
              a translucent sheet. */}
          <RadixPopover.Arrow className="fill-[var(--glass-2)]" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export const PopoverClose = RadixPopover.Close;
