import { useVocab, type Vocab } from '@/i18n';
import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import { DesktopUpdateFrame } from '@/design/DesktopUpdateFrame';


const GHOST_BTN_CLASS =
  'box-border flex h-9 items-center rounded-[var(--r-control)] border border-proto-line px-4 text-[12.5px] ' +
  '[background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] font-semibold text-proto-muted transition-colors hover:bg-surface-canvas-alt disabled:opacity-60 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent';

const PRIMARY_BTN_CLASS =
  'box-border flex h-9 items-center rounded-[var(--r-control)] bg-state-ink px-4 text-[12.5px] font-semibold ' +
  'text-[var(--ink-solid-fg)] transition-opacity hover:opacity-90 disabled:opacity-60 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent';

export interface ServerUpdateDialogProps {
  status: SystemUpdateStatus;
  busy: boolean;
  onApply: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}

/** Mono meta line under the title. */
export function serverUpdateSummaryLine(status: SystemUpdateStatus): string {
  const version = status.available ?? '';
  return version ? `Cortex ${version}` : 'Cortex';
}

export function serverUpdateTitle(state: SystemUpdateStatus['state'], L: Vocab): string {
  switch (state) {
    case 'installing': return L.updateInstalling;
    case 'restarting': return L.updateReconnecting;
    case 'failed': return L.updateFailed;
    default: return L.updateNewAvailable;
  }
}

export function serverUpdateDescription(status: SystemUpdateStatus, L: Vocab): string {
  const version = status.available ?? L.updateNewVersion;
  switch (status.state) {
    case 'installing':
      return L.updateInstallingHint;
    case 'restarting':
      return L.updateReconnectingHint;
    case 'failed':
      return L.updateFailedHint;
    default:
      return L.updateConfirmVersion.replace('{version}', version);
  }
}

function ServerUpdateActions(props: ServerUpdateDialogProps) {
  const L = useVocab();
  if (props.status.state === 'prompting') {
    return (
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={props.onSkip} disabled={props.busy} className={GHOST_BTN_CLASS}>
          {L.updateSkipVersion}
        </button>
        <button type="button" onClick={props.onDismiss} className={GHOST_BTN_CLASS}>
          {L.updateLater}
        </button>
        <button type="button" onClick={props.onApply} disabled={props.busy} className={PRIMARY_BTN_CLASS}>
          {props.busy ? L.updateBusy : L.updateApply}
        </button>
      </div>
    );
  }
  // installing / restarting / failed: the work is already underway (or over) server-side, so the
  // only thing left to offer is getting the dialog out of the way.
  return (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={props.onDismiss} className={GHOST_BTN_CLASS}>
        {props.status.state === 'failed' ? L.updateClose : L.updateContinueBackground}
      </button>
    </div>
  );
}

export function ServerUpdateDialog(props: ServerUpdateDialogProps) {
  const L = useVocab();
  return (
    <DesktopUpdateFrame
      title={serverUpdateTitle(props.status.state, L)}
      summary={serverUpdateSummaryLine(props.status)}
      descriptionId="server-update-desc"
      description={serverUpdateDescription(props.status, L)}
      onDismiss={props.onDismiss}
    >
      {props.status.error ? (
        <pre className="mb-3 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-[var(--r-control)] bg-surface-canvas-alt p-2 font-mono text-[11.5px] leading-relaxed text-state-fail">
          {props.status.error}
        </pre>
      ) : null}
      <ServerUpdateActions {...props} />
    </DesktopUpdateFrame>
  );
}
