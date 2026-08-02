// input:  DEBUG detail, localized labels, layered Modal
// output: inspector control and character-counted nested dialog
// pos:    desktop DEBUG behavior surface
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

const DEBUG_MODAL_SIZE = 'wide' as const;

export function characterCount(value: string): number {
  return Array.from(value).length;
}

export function formatDebugValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

function DebugBlock({ label, status, count, children }: {
  label: string;
  status?: string;
  count?: number;
  children: string;
}): JSX.Element {
  const L = useVocab();
  return (
    <section className="flex flex-col gap-1g">
      <div className="flex items-center gap-1g font-mono text-[10px] font-semibold tracking-[.06em] text-proto-muted">
        <span>{label}</span>
        {status ? <span className="rounded border border-proto-line-2 bg-proto-alt px-1g py-[1px] text-[9px]">{status}</span> : null}
        {count !== undefined ? <span className="ml-auto font-normal tracking-normal text-proto-faint">{count} {L.wbDebugCharacters}</span> : null}
      </div>
      <pre className="max-h-[38vh] overflow-auto whitespace-pre-wrap break-words rounded-card border border-proto-line-2 bg-proto-alt p-2g font-mono text-[11px] leading-relaxed text-proto-ink-2">{children}</pre>
    </section>
  );
}

function DebugDetailsContent({ detail }: { detail: DebugDetail }): JSX.Element {
  const L = useVocab();
  if (detail.kind === 'user') {
    return <DebugBlock label={L.wbDebugAgentMessage} count={characterCount(detail.agentMessage)}>{detail.agentMessage}</DebugBlock>;
  }
  const input = formatDebugValue(detail.toolInput);
  const resultStatus = detail.toolResult
    ? (detail.toolResult.isError ? L.wbDebugError : L.wbDebugSuccess)
    : L.wbDebugPending;
  return (
    <div className="flex flex-col gap-2g">
      <DebugBlock label={L.wbDebugParameters} count={characterCount(input)}>{input}</DebugBlock>
      <DebugBlock label={L.wbDebugResult} status={resultStatus} count={detail.toolResult ? characterCount(detail.toolResult.content) : undefined}>
        {detail.toolResult?.content ?? L.wbDebugPending}
      </DebugBlock>
    </div>
  );
}

export function DebugInspectButton({ onClick, compact = false, className = '' }: {
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  compact?: boolean;
  className?: string;
}): JSX.Element {
  const L = useVocab();
  const label = L.wbDebugInspect;
  const sizeClass = compact ? 'h-[18px] min-w-[22px] px-[4px] text-[8px]' : 'h-[24px] min-w-[28px] px-[5px] text-[9px]';
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`pointer-events-none ${sizeClass} rounded border border-proto-line-2 bg-proto-card font-mono text-proto-muted opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent/30 ${className}`}
    >
      {'{ }'}
    </button>
  );
}

export function DebugDetailsModal({ detail, onClose }: { detail: DebugDetail | null; onClose: () => void }): JSX.Element {
  const L = useVocab();
  const title = detail?.kind === 'tool' ? `DEBUG · ${detail.toolName}` : `DEBUG · ${L.wbDebugAgentMessage}`;
  return (
    <Modal
      title={title}
      open={detail !== null}
      size={DEBUG_MODAL_SIZE}
      layer="nested"
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      {detail ? <DebugDetailsContent detail={detail} /> : null}
    </Modal>
  );
}
