// input:  optional lossless user/tool DEBUG transcript detail
// output: hover/focus inspector button, readable full-value content, controlled Radix modal
// pos:    desktop workbench DEBUG presentation; never rendered by mobile transcript surfaces
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { MouseEvent } from 'react';
import { Modal } from '@/design/Modal';
import { useVocab } from '@/i18n';

export type DebugDetail =
  | { kind: 'user'; agentMessage: string }
  | {
      kind: 'tool';
      toolName: string;
      toolInput: unknown;
      toolResult?: { content: string; isError: boolean };
    };

export function formatDebugValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

function DebugBlock({ label, status, children }: { label: string; status?: string; children: string }): JSX.Element {
  return (
    <section className="flex flex-col gap-1g">
      <div className="flex items-center gap-1g font-mono text-[10px] font-semibold tracking-[.06em] text-proto-muted">
        <span>{label}</span>
        {status ? <span className="rounded border border-proto-line-2 bg-proto-alt px-1g py-[1px] text-[9px]">{status}</span> : null}
      </div>
      <pre className="max-h-[38vh] overflow-auto whitespace-pre-wrap break-words rounded-card border border-proto-line-2 bg-proto-alt p-2g font-mono text-[11px] leading-relaxed text-proto-ink-2">{children}</pre>
    </section>
  );
}

/** Exported separately so complete-value rendering is testable without a browser portal. */
export function DebugDetailsContent({ detail }: { detail: DebugDetail }): JSX.Element {
  const L = useVocab();
  if (detail.kind === 'user') {
    return <DebugBlock label={L.wbDebugAgentMessage}>{detail.agentMessage}</DebugBlock>;
  }
  const resultStatus = detail.toolResult
    ? (detail.toolResult.isError ? L.wbDebugError : L.wbDebugSuccess)
    : L.wbDebugPending;
  return (
    <div className="flex flex-col gap-2g">
      <DebugBlock label={L.wbDebugParameters}>{formatDebugValue(detail.toolInput)}</DebugBlock>
      <DebugBlock label={L.wbDebugResult} status={resultStatus}>{detail.toolResult?.content ?? L.wbDebugPending}</DebugBlock>
    </div>
  );
}

export function DebugInspectButton({ onClick, className = '' }: {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}): JSX.Element {
  const L = useVocab();
  const label = L.wbDebugInspect;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`pointer-events-none h-[24px] min-w-[28px] rounded border border-proto-line-2 bg-proto-card px-[5px] font-mono text-[9px] text-proto-muted opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent/30 ${className}`}
    >
      {'{ }'}
    </button>
  );
}

export function DebugDetailsModal({ detail, onClose }: { detail: DebugDetail | null; onClose: () => void }): JSX.Element {
  const L = useVocab();
  const title = detail?.kind === 'tool' ? `DEBUG · ${detail.toolName}` : `DEBUG · ${L.wbDebugAgentMessage}`;
  return (
    <Modal title={title} open={detail !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {detail ? <DebugDetailsContent detail={detail} /> : null}
    </Modal>
  );
}
