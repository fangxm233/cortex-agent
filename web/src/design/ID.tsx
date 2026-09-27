import { useVocabOptional } from '@/i18n';
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
  const L = useVocabOptional();

  if (!copyable) return <MonoText muted className={className}>{value}</MonoText>;

  return (
    <button
      type="button"
      onClick={() => { void copy(value, true); }}
      title={copied ? L.cmCopied : L.cmCopy}
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
