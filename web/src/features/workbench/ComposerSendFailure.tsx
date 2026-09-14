import { useVocab } from '@/i18n';

const mono = "'IBM Plex Mono',monospace";

export function ComposerSendFailure({ error }: { error: string }): JSX.Element {
  const L = useVocab();
  return (
    <div
      data-send-error
      role="alert"
      style={{ marginTop: 7, padding: '0 2px', font: `500 10.5px ${mono}`, color: 'var(--proto-danger)' }}
    >
      {L.wbSendFailed} · {L.wbDraftRestored}: {error}
    </div>
  );
}
