import '@/design/content-surfaces.css';
import { useVocabOptional } from '@/i18n';

function NotesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--proto-muted)', flex: 'none' }}>
      <path d="M3 13h3l7-7-3-3-7 7z" />
    </svg>
  );
}

/**
 * The notes toggle. Its chrome comes from the caller's `className` — the Overview header renders it
 * as one of its hairline capsules, where the open state is the shared gray tint (aria-pressed), not
 * an accent fill. The open-note count is a plain number, shown only when there is one.
 */
export function NotesButton({ count, active, onClick, className }: {
  count: number;
  active: boolean;
  onClick: () => void;
  className?: string;
}) {
  const copy = useVocabOptional();
  return (
    <button
      className={['content-surface', className].filter(Boolean).join(' ')}
      type="button"
      data-notes-button=""
      aria-pressed={active}
      onClick={onClick}
      title={`${copy.noteTitle} · ⌘⇧N`}
    >
      <NotesIcon />
      <span>{copy.noteTitle}</span>
      {count > 0 && <span style={{ color: 'var(--proto-muted-3)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
    </button>
  );
}
