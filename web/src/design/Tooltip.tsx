import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';

// Token-styled wrapper over Radix Tooltip (approved primitive layer, design §1):
// positioning/a11y from Radix, colors from tokens (ink surface, card text).
// Mount `TooltipProvider` once near the app root.
//
// Stays an OPAQUE ink chip while the other overlays went to glass, and gets no `backdrop-filter`.
// A tooltip is a label, not a sheet: it is the one overlay that must stay legible on top of any
// surface at all, including another overlay, so it inverts rather than dissolving into what it
// covers. Its radius follows the chip step for the same reason — it is chip-sized.

export const TooltipProvider = RadixTooltip.Provider;

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: RadixTooltip.TooltipContentProps['side'];
  delayDuration?: number;
}

export function Tooltip({ content, children, side = 'top', delayDuration }: TooltipProps) {
  return (
    <RadixTooltip.Root delayDuration={delayDuration}>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          side={side}
          sideOffset={4}
          className="z-50 rounded-[var(--r-chip)] bg-state-ink px-1g py-0.5g font-sans text-ui text-surface-card shadow-card"
        >
          {content}
          <RadixTooltip.Arrow className="fill-state-ink" />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
