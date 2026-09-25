// input:  Radix dialog, ReactNode, update copy and dismiss callback
// output: DesktopUpdateFrame and DesktopUpdateFrameProps
// pos:    Shared accessible material sheet for update prompts
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import * as RadixDialog from '@radix-ui/react-dialog';
import type { ReactNode } from 'react';

const OVERLAY_CLASS =
  'fixed inset-0 z-40 bg-state-ink/[0.44] ' +
  '[backdrop-filter:var(--material-scrim-filter)] [-webkit-backdrop-filter:var(--material-scrim-filter)] ' +
  'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none';

const CONTENT_CLASS =
  'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 ' +
  'w-[420px] max-w-[calc(100vw-32px)] box-border ' +
  // Floating glass sheet, matching design/Modal's standard panel — a top-level overlay is the one
  // shape `backdrop-filter` is affordable on, and this one holds still for its whole lifetime.
  'rounded-[var(--r-float)] [background:var(--material-overlay-bg)] ' +
  '[backdrop-filter:var(--glass-filter)] [-webkit-backdrop-filter:var(--glass-filter)] ' +
  'p-5 pb-4 shadow-[shadow:var(--material-overlay-shadow)] focus:outline-none ' +
  'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out motion-reduce:animate-none';

export interface DesktopUpdateFrameProps {
  title: string;
  summary: string;
  descriptionId: string;
  description: ReactNode;
  onDismiss: () => void;
  children: ReactNode;
}

function DesktopUpdateHeader(props: Pick<DesktopUpdateFrameProps, 'title' | 'summary'>) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex h-9 w-9 flex-none items-center justify-center rounded-[var(--r-control)] bg-proto-accent-bg text-state-run">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M10 14V4M5.5 8.5 10 4l4.5 4.5" />
          <path d="M3.5 16.5h13" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <RadixDialog.Title className="text-body font-semibold text-state-ink">{props.title}</RadixDialog.Title>
        <div className="mt-1 break-words font-mono text-[11.5px] font-medium leading-relaxed text-proto-muted">{props.summary}</div>
      </div>
    </div>
  );
}

export function DesktopUpdateFrame(props: DesktopUpdateFrameProps) {
  return (
    <RadixDialog.Root open onOpenChange={(next) => { if (!next) props.onDismiss(); }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY_CLASS} />
        <RadixDialog.Content className={CONTENT_CLASS} aria-describedby={props.descriptionId}>
          <DesktopUpdateHeader title={props.title} summary={props.summary} />
          <RadixDialog.Description
            id={props.descriptionId}
            className="mb-4 mt-3 text-[12.5px] leading-[1.65] text-proto-muted"
          >
            {props.description}
          </RadixDialog.Description>
          {props.children}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
