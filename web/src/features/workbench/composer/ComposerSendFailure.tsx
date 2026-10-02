import { useVocab } from '@/i18n';
import { findHttpTransportError } from '@/lib/http-transport';

const mono = "'IBM Plex Mono',monospace";

export function ComposerSendFailure({ error }: { error: Error }): JSX.Element {
  const L = useVocab();
  const transport = findHttpTransportError(error);
  const messages = {
    connection: L.wbSendConnectionFailed,
    authentication: L.wbSendAuthenticationFailed,
    access: L.wbSendAccessDenied,
    unexpected: L.wbSendUnexpectedResponse,
  };
  const message = transport ? messages[transport.kind] : error.message;
  return (
    <div
      data-send-error
      role="alert"
      style={{ marginTop: 7, padding: '0 2px', font: `500 11px ${mono}`, color: 'var(--proto-danger)' }}
    >
      {L.wbSendFailed} · {L.wbDraftRestored}: {message}
    </div>
  );
}
