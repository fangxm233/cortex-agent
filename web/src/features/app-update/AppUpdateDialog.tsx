import { useVocab } from '@/i18n';
import { DesktopUpdateFrame } from '@/design/DesktopUpdateFrame';
import {
  appUpdateSummaryLine,
  installCtaLabel,
  installDescription,
  type AppUpdateInfo,
} from './app-update';
import { installErrorText } from './install-error';

const GHOST_BTN_CLASS =
  'box-border flex h-9 items-center rounded-[var(--r-control)] border border-proto-line px-4 text-[12.5px] ' +
  '[background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] font-semibold text-proto-muted transition-colors hover:bg-surface-canvas-alt ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent';

export interface AppUpdateDialogProps {
  update: AppUpdateInfo;
  busy: boolean;
  error: string | null;
  onInstall: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}

function AppUpdateActions(props: AppUpdateDialogProps) {
  const L = useVocab();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" onClick={props.onSkip} className={GHOST_BTN_CLASS}>
        {L.updateSkipVersion}
      </button>
      <button type="button" onClick={props.onDismiss} className={GHOST_BTN_CLASS}>
        {L.updateLater}
      </button>
      <button
        type="button"
        onClick={props.onInstall}
        disabled={props.busy}
        className="box-border flex h-9 items-center rounded-[var(--r-control)] bg-state-ink px-4 text-[12.5px] font-semibold text-[var(--ink-solid-fg)] transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent"
      >
        {props.busy ? L.updateBusy : installCtaLabel(props.update.kind, L)}
      </button>
    </div>
  );
}

export function AppUpdateDialog(props: AppUpdateDialogProps) {
  const L = useVocab();
  return (
    <DesktopUpdateFrame
      title={L.updateReady}
      summary={appUpdateSummaryLine(props.update, L)}
      descriptionId="app-update-desc"
      description={installDescription(props.update.kind, L)}
      onDismiss={props.onDismiss}
    >
      {props.error ? (
        <div className="mb-3 text-[11.5px] leading-snug text-state-fail">{L.updateInstallFailed.replace('{error}', installErrorText(props.error, L))}</div>
      ) : null}
      <AppUpdateActions {...props} />
    </DesktopUpdateFrame>
  );
}
