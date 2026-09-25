// input:  Localized copy, send failure text
// output: ComposerSendFailure
// pos:    Readable send failure and draft restoration feedback
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { useVocab } from '@/i18n';

const mono = "'IBM Plex Mono',monospace";

export function ComposerSendFailure({ error }: { error: string }): JSX.Element {
  const L = useVocab();
  return (
    <div
      data-send-error
      role="alert"
      style={{ marginTop: 7, padding: '0 2px', font: `500 11px ${mono}`, color: 'var(--proto-danger)' }}
    >
      {L.wbSendFailed} · {L.wbDraftRestored}: {error}
    </div>
  );
}
