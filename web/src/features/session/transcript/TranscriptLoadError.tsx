import { MENU_FOCUS } from '@/design/MenuChrome';
import { useVocab } from '@/i18n';

export function TranscriptLoadError({ onRetry }: { onRetry: () => void }): JSX.Element {
  const L = useVocab();
  return (
    <div role="alert" style={{ alignSelf: 'start', justifySelf: 'center', padding: 16, fontSize: 12, color: 'var(--proto-danger)' }}>
      {L.msgHistoryFailed}
      <button type="button" className={MENU_FOCUS} onClick={onRetry}
        style={{ marginLeft: 8, color: 'var(--proto-accent)', cursor: 'pointer' }}>
        {L.msgRetry}
      </button>
    </div>
  );
}
