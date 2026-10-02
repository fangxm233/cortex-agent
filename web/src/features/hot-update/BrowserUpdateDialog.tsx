import { DesktopUpdateFrame } from '@/design/DesktopUpdateFrame';
import { useVocab } from '@/i18n';

export function BrowserUpdateDialog({ onApply, onDismiss }: { onApply: () => void; onDismiss: () => void }) {
  const L = useVocab();
  return (
    <DesktopUpdateFrame title={L.updateNewAvailable} summary={L.updateCheckUi}
      descriptionId="browser-update-desc" description={L.updatePageHint} onDismiss={onDismiss}>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className="rounded-[var(--r-control)] border border-proto-line px-4 py-2 text-sm"
          onClick={onDismiss}>{L.updateLater}</button>
        <button type="button" className="rounded-[var(--r-control)] bg-state-ink px-4 py-2 text-sm text-[var(--ink-solid-fg)]"
          onClick={onApply}>{L.updateRefreshPage}</button>
      </div>
    </DesktopUpdateFrame>
  );
}
