import type { CSSProperties } from 'react';
import { useVocabOptional } from '@/i18n';
import { useUnsentActionsContext } from './useUnsentActions';

const linkStyle: CSSProperties = {
  background: 'none', border: 0, padding: 0, font: 'inherit', fontWeight: 600,
  color: 'var(--proto-accent)', cursor: 'pointer',
};

/** The line under an unsent message: its state, then send / edit. Always visible — it is the one
 *  thing on the row the user has to act on. */
export function UnsentActions({ pendingId, fontSize }: { pendingId: string; fontSize: number }): JSX.Element {
  const L = useVocabOptional();
  const actions = useUnsentActionsContext();
  const disabled = !actions || actions.busy;
  return (
    <div data-unsent="" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 10, fontSize, color: 'var(--proto-muted)' }}>
      <span>{L.msgUnsent}</span>
      {actions && (
        <>
          <button type="button" disabled={disabled} onClick={() => actions.resolve(pendingId, 'send')} style={linkStyle}>
            {L.msgUnsentSend}
          </button>
          <button type="button" disabled={disabled} onClick={() => actions.resolve(pendingId, 'edit')} style={linkStyle}>
            {L.msgUnsentEdit}
          </button>
        </>
      )}
    </div>
  );
}
