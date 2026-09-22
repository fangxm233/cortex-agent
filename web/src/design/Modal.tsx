// input:  Radix Dialog, React, shared focus-visible styles
// output: Modal, ModalClose, modal styling helpers
// pos:    Accessible dialogs with readable standard chrome
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import * as RadixDialog from '@radix-ui/react-dialog';
import type { CSSProperties, ReactNode } from 'react';

// Radix owns focus trapping, Escape dismissal, aria-modal, scroll lock, and focus restore in both
// chrome modes. Standard retains the token-styled shell; bare only removes visible design chrome so
// approved prototype shells can keep their exact inline appearance without giving up dialog semantics.
//
// The standard panel is a floating glass sheet: `--glass-2` over its own `backdrop-filter`, lifted
// by `--shadow-float`, whose hairline ring replaces the border it used to carry. This is the one
// element in the file that may blur — it is a single overlay that holds still while the body
// scrolls inside it, so the backdrop is sampled once per open rather than once per scroll frame.
// `bare` is deliberately left unfiltered: its whole contract is that the call site owns the look.

const OVERLAY_BASE_CLASS =
  'fixed inset-0 bg-state-ink/40 ' +
  'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out ' +
  'motion-reduce:animate-none ';

const CONTENT_BASE_CLASS =
  'fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 ' +
  'flex max-h-[85vh] w-[90vw] flex-col gap-2g ' +
  'rounded-[var(--r-float)] bg-[var(--glass-2)] ' +
  '[backdrop-filter:var(--glass-filter)] [-webkit-backdrop-filter:var(--glass-filter)] ' +
  'p-3g shadow-[shadow:var(--shadow-float)] ' +
  'focus:outline-none ' +
  'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out ' +
  'motion-reduce:animate-none ';

const CLOSE_CLASS =
  '-mr-1g -mt-1g rounded-[var(--r-control)] p-0.5g text-ui text-proto-muted transition-colors ' +
  'hover:bg-surface-canvas-alt hover:text-state-ink';

export type ModalChrome = 'standard' | 'bare';
export type ModalSize = 'default' | 'wide' | 'custom';
export type ModalLayer = 'default' | 'nested';
export type ModalDataAttributes = Partial<Record<`data-${string}`, string | number | boolean | undefined>>;

const CONTENT_SIZE_CLASS: Record<ModalSize, string> = {
  default: 'max-w-lg',
  wide: 'max-w-3xl',
  custom: '',
};

const LAYER_CLASS: Record<ModalLayer, { overlay: string; content: string }> = {
  default: { overlay: 'z-40', content: 'z-50' },
  nested: { overlay: 'z-[80]', content: 'z-[90]' },
};

const BARE_LAYER: Record<ModalLayer, { overlay: number; content: number }> = {
  default: { overlay: 60, content: 61 },
  nested: { overlay: 80, content: 90 },
};

export function modalOverlayClass(layer: ModalLayer = 'default'): string {
  return OVERLAY_BASE_CLASS + LAYER_CLASS[layer].overlay;
}

export function modalContentClass(size: ModalSize = 'default', layer: ModalLayer = 'default'): string {
  return `${CONTENT_BASE_CLASS}${CONTENT_SIZE_CLASS[size]} ${LAYER_CLASS[layer].content}`;
}

export interface ModalProps {
  title: ReactNode;
  description?: ReactNode;
  hideTitle?: boolean;
  hideDescription?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  chrome?: ModalChrome;
  size?: ModalSize;
  layer?: ModalLayer;
  showClose?: boolean;
  contentStyle?: CSSProperties;
  contentClassName?: string;
  bodyStyle?: CSSProperties;
  contentDataAttributes?: ModalDataAttributes;
  overlayDataAttributes?: ModalDataAttributes;
}

function CloseControl(): JSX.Element {
  return <RadixDialog.Close aria-label="Close" className={CLOSE_CLASS}>✕</RadixDialog.Close>;
}

function ModalHeader({ title, hideTitle, showClose }: Pick<ModalProps, 'title' | 'hideTitle'> & {
  showClose: boolean;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2g">
      <RadixDialog.Title className={hideTitle ? 'sr-only' : 'text-body font-medium text-state-ink'}>
        {title}
      </RadixDialog.Title>
      {showClose ? <CloseControl /> : null}
    </div>
  );
}

function ModalBody({ children, chrome, bodyStyle }: Pick<ModalProps, 'children' | 'bodyStyle'> & {
  chrome: ModalChrome;
}): JSX.Element | null {
  if (!children) return null;
  const className = chrome === 'standard'
    ? 'min-w-0 overflow-x-hidden overflow-y-auto text-ui leading-relaxed text-proto-ink-2'
    : undefined;
  return <div data-modal-body={true} className={className} style={bodyStyle}>{children}</div>;
}

function StandardPanel(props: ModalProps & { showClose: boolean }): JSX.Element {
  const { title, description, hideTitle, hideDescription, children, footer, bodyStyle,
    contentStyle, contentClassName = '', contentDataAttributes, size = 'default', layer = 'default', showClose } = props;
  return (
    <RadixDialog.Content {...contentDataAttributes} className={`${modalContentClass(size, layer)} ${contentClassName}`} style={contentStyle}>
      <ModalHeader title={title} hideTitle={hideTitle} showClose={showClose} />
      {description ? <RadixDialog.Description
        className={hideDescription ? 'sr-only' : 'min-w-0 break-words text-ui leading-relaxed text-proto-muted [overflow-wrap:anywhere]'}
      >{description}</RadixDialog.Description> : null}
      <ModalBody chrome="standard" bodyStyle={bodyStyle}>{children}</ModalBody>
      {footer ? <div className="flex flex-wrap items-center justify-end gap-1g pt-1g">{footer}</div> : null}
    </RadixDialog.Content>
  );
}

function BarePanel(props: ModalProps & { showClose: boolean }): JSX.Element {
  const { title, description, children, contentStyle, contentClassName = '', bodyStyle, contentDataAttributes,
    layer = 'default', showClose } = props;
  const style = { ...contentStyle, zIndex: BARE_LAYER[layer].content };
  return (
    <RadixDialog.Content {...contentDataAttributes} className={`focus:outline-none ${contentClassName}`} style={style}>
      <RadixDialog.Title className="sr-only">{title}</RadixDialog.Title>
      <RadixDialog.Description className="sr-only">{description ?? title}</RadixDialog.Description>
      {showClose ? <CloseControl /> : null}
      <ModalBody chrome="bare" bodyStyle={bodyStyle}>{children}</ModalBody>
    </RadixDialog.Content>
  );
}

function ModalOverlay({ chrome, layer, data }: {
  chrome: ModalChrome; layer: ModalLayer; data?: ModalDataAttributes;
}): JSX.Element {
  if (chrome === 'standard') return <RadixDialog.Overlay {...data} className={modalOverlayClass(layer)} />;
  return <RadixDialog.Overlay {...data} className="fixed inset-0"
    style={{ background: 'var(--overlay-scrim)', animation: 'cxfade .18s ease', zIndex: BARE_LAYER[layer].overlay }} />;
}

export function Modal({ trigger, open, onOpenChange, chrome = 'standard', layer = 'default',
  showClose, ...panel }: ModalProps): JSX.Element {
  const visibleClose = showClose ?? chrome === 'standard';
  const panelProps = { ...panel, chrome, layer, showClose: visibleClose };
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <RadixDialog.Trigger asChild>{trigger}</RadixDialog.Trigger> : null}
      <RadixDialog.Portal>
        <ModalOverlay chrome={chrome} layer={layer} data={panel.overlayDataAttributes} />
        {chrome === 'bare' ? <BarePanel {...panelProps} /> : <StandardPanel {...panelProps} />}
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const ModalClose = RadixDialog.Close;
