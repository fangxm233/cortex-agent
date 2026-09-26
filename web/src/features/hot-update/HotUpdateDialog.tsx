import { useVocab } from '@/i18n';
import { DesktopUpdateFrame } from '@/design/DesktopUpdateFrame';
import { updateSummaryLine, type StagedUpdate } from './frontend-update';

export interface HotUpdateDialogProps {
  update: StagedUpdate;
  onApply: () => void;
  onDismiss: () => void;
}

function HotUpdateActions(props: Pick<HotUpdateDialogProps, 'onApply' | 'onDismiss'>) {
  const L = useVocab();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button
        type="button"
        onClick={props.onDismiss}
        className="box-border flex h-9 items-center rounded-[var(--r-control)] border border-proto-line [background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] px-4 text-[12.5px] font-semibold text-proto-muted transition-colors hover:bg-surface-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent"
      >
        {L.updateIgnore}
      </button>
      <button
        type="button"
        onClick={props.onApply}
        className="box-border flex h-9 items-center rounded-[var(--r-control)] bg-state-ink px-4 text-[12.5px] font-semibold text-[var(--ink-solid-fg)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent"
      >
        {L.updateRestartApp}
      </button>
    </div>
  );
}

export function HotUpdateDialog(props: HotUpdateDialogProps) {
  const L = useVocab();
  return (
    <DesktopUpdateFrame
      title={L.updateReady}
      summary={updateSummaryLine(props.update, L)}
      descriptionId="hot-update-desc"
      description={L.updateHotHint}
      onDismiss={props.onDismiss}
    >
      <HotUpdateActions onApply={props.onApply} onDismiss={props.onDismiss} />
    </DesktopUpdateFrame>
  );
}
