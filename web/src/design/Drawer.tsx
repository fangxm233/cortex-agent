// input:  Radix Dialog, React, shared focus-visible styles
// output: Drawer, DrawerClose, DrawerProps, DrawerSide
// pos:    Accessible side sheets with readable body and close control
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

// Radix owns focus trapping, dismissal, scroll locking and focus restoration.
const OVERLAY_CLASS =
  'fixed inset-0 z-40 bg-state-ink/40 ' +
  'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out ' +
  'motion-reduce:animate-none';

const SIDE_CLASS = {
  right: 'right-0 data-[state=open]:animate-slide-in-right data-[state=closed]:animate-slide-out-right',
  left: 'left-0 data-[state=open]:animate-slide-in-left data-[state=closed]:animate-slide-out-left',
} as const;

// Only the stationary sheet blurs; the scrolling body and its cards stay unfiltered.
const CONTENT_CLASS =
  'fixed inset-y-0 z-50 flex h-full w-[92vw] max-w-md flex-col gap-2g ' +
  'rounded-[var(--r-float)] bg-[var(--glass-2)] ' +
  '[backdrop-filter:var(--glass-filter)] [-webkit-backdrop-filter:var(--glass-filter)] ' +
  'p-3g shadow-[shadow:var(--shadow-float)] focus:outline-none motion-reduce:animate-none ';

const CLOSE_CLASS =
  '-mr-1g -mt-1g rounded-[var(--r-control)] p-0.5g text-ui text-proto-muted transition-colors ' +
  'hover:bg-surface-canvas-alt hover:text-state-ink';

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

function DrawerHeader({ title, hideTitle }: DrawerProps) {
  return (
    <div className="flex items-start justify-between gap-2g">
      <RadixDialog.Title className={hideTitle ? 'sr-only' : 'text-body font-medium text-state-ink'}>
        {title}
      </RadixDialog.Title>
      <RadixDialog.Close aria-label="Close" className={CLOSE_CLASS}>✕</RadixDialog.Close>
    </div>
  );
}

function DrawerContent({ side = 'right', description, children, footer, ...header }: DrawerProps) {
  return (
    <RadixDialog.Content className={CONTENT_CLASS + SIDE_CLASS[side]}>
      <DrawerHeader {...header} />
      {description ? (
        <RadixDialog.Description className="text-ui leading-relaxed text-proto-muted [overflow-wrap:anywhere]">
          {description}
        </RadixDialog.Description>
      ) : null}
      {children ? (
        <div className="flex-1 overflow-y-auto text-ui leading-relaxed text-proto-ink-2">{children}</div>
      ) : null}
      {footer ? <div className="flex items-center justify-end gap-1g pt-1g">{footer}</div> : null}
    </RadixDialog.Content>
  );
}

export function Drawer({ trigger, open, onOpenChange, ...panel }: DrawerProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY_CLASS} />
        <DrawerContent {...panel} />
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DrawerClose = RadixDialog.Close;
