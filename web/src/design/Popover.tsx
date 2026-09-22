// input:  Radix Popover, React, material and glass tokens
// output: Popover, PopoverClose, PopoverProps
// pos:    Anchored material overlays with Radix focus handling
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import * as RadixPopover from '@radix-ui/react-popover';
import type { ReactNode } from 'react';

// Token-styled wrapper over Radix Popover (approved primitive layer, design §1):
// positioning, esc-to-close and focus return to the trigger come from Radix.
// Supports controlled (`open`/`onOpenChange`) and uncontrolled usage.
//
// Blur belongs to the overlay shell, not its rows. Stationary overlays can still resample
// a changing backdrop; no assumption of a once-per-open cached blur is made here.

const CONTENT_CLASS =
  'z-50 min-w-[12rem] rounded-[var(--r-float)] [background:var(--material-overlay-bg)] ' +
  '[backdrop-filter:var(--glass-filter)] [-webkit-backdrop-filter:var(--glass-filter)] ' +
  'p-2g text-ui text-state-ink shadow-[shadow:var(--material-overlay-shadow)] ' +
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
          {/* SVG fill needs a color, not the material background shorthand. */}
          <RadixPopover.Arrow className="fill-[color-mix(in_srgb,var(--proto-card)_20%,var(--glass-2))]" />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}

export const PopoverClose = RadixPopover.Close;
