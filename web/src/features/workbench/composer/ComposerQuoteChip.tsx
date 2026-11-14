import { MENU_FOCUS } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';
import { quotePreview } from '@/features/session/transcript/message-quote';

/** The reply being quoted, above the input: a muted, clamped block the next send carries. */
export function ComposerQuoteChip({ text, onRemove }: { text: string; onRemove: () => void }): JSX.Element {
  const L = useVocab();
  return (
    <div data-composer-quote="" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '2px 0 10px 2px' }}>
      <div
        style={{
          flex: 1, minWidth: 0, borderLeft: '2px solid var(--proto-line-3)', paddingLeft: 8,
          fontSize: 12.5, lineHeight: 1.5, color: 'var(--proto-muted)', wordBreak: 'break-word',
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}
      >
        {quotePreview(text)}
      </div>
      <button
        type="button" className={MENU_FOCUS}
        aria-label={L.msgQuoteRemove} title={L.msgQuoteRemove}
        onClick={onRemove}
        style={{
          flex: 'none', width: 20, height: 20, borderRadius: 'var(--r-chip)', border: 0, padding: 0,
          background: 'transparent', color: 'var(--proto-muted)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
          <path d="M2 2l6 6M8 2l-6 6" />
        </svg>
      </button>
    </div>
  );
}
