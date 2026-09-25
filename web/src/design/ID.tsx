// input:  MonoText, clipboard feedback, shared focus-visible styles
// output: ID, IDProps
// pos:    Readable identifiers with optional copy feedback
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<

import { MonoText } from './MonoText';
import { useClipboardFeedback } from './useClipboardFeedback';

export interface IDProps {
  value: string;
  copyable?: boolean;
  className?: string;
}

export function ID({ value, copyable, className }: IDProps) {
  const { copiedKey, copy } = useClipboardFeedback<true>(1200);
  const copied = copiedKey === true;

  if (!copyable) return <MonoText muted className={className}>{value}</MonoText>;

  return (
    <button
      type="button"
      onClick={() => { void copy(value, true); }}
      title={copied ? 'Copied' : 'Copy'}
      className={[
        'group inline-flex items-center gap-0.5g rounded-[var(--r-chip)] px-0.5g font-mono text-ui',
        'text-proto-muted transition-colors hover:bg-surface-canvas-alt hover:text-state-ink',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {value}
      <span className="text-proto-muted-3 group-hover:text-proto-ink">
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  );
}
