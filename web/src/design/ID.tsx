// input:  identifier value, copyability, class names, and shared clipboard feedback
// output: monospace identifier text or a success-aware copy button
// pos:    Design-system identifier primitive
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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

  if (!copyable) {
    return (
      <MonoText muted className={className}>
        {value}
      </MonoText>
    );
  }

  return (
    <button
      type="button"
      onClick={() => { void copy(value, true); }}
      title={copied ? 'Copied' : 'Copy'}
      className={[
        'group inline-flex items-center gap-0.5g rounded-card px-0.5g font-mono text-ui',
        'text-state-ink/60 transition-colors hover:bg-surface-canvas-alt hover:text-state-ink',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {value}
      <span className="text-state-ink/40 group-hover:text-state-ink/70">
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  );
}
