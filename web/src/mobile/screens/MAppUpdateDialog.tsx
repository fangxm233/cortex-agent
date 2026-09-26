import { useVocab } from '@/i18n';
import type { CSSProperties } from 'react';
import {
  appUpdateSummaryLine,
  installCtaLabel,
  installDescription,
  type AppUpdateInfo,
} from '@/features/app-update/app-update';
import { MUpdateFrame } from './MUpdateFrame';

const ACTIONS_STYLE: CSSProperties = {
  width: '100%', display: 'flex', flexDirection: 'column', gap: 2,
};
const PRIMARY_STYLE: CSSProperties = {
  height: 48, border: 'none', borderRadius: 'var(--r-card)', background: 'var(--proto-ink)',
  boxShadow: 'var(--accent-glow)', color: 'var(--ink-solid-fg)', display: 'flex', alignItems: 'center',
  justifyContent: 'center', fontSize: 14.5, fontWeight: 600, cursor: 'pointer', width: '100%',
};
const SECONDARY_STYLE: CSSProperties = {
  height: 44, border: 'none', background: 'transparent', display: 'flex',
  alignItems: 'center', justifyContent: 'center', fontSize: 13.5, fontWeight: 600,
  color: 'var(--proto-muted-2)', cursor: 'pointer', flex: 1,
};

export interface MAppUpdateDialogProps {
  update: AppUpdateInfo;
  busy: boolean;
  error: string | null;
  onInstall: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}

function MAppUpdateActions(props: MAppUpdateDialogProps) {
  const L = useVocab();
  return (
    <div style={ACTIONS_STYLE}>
      <button
        type="button"
        onClick={props.onInstall}
        disabled={props.busy}
        style={{ ...PRIMARY_STYLE, opacity: props.busy ? 0.6 : 1 }}
      >
        {props.busy ? L.updateBusy : installCtaLabel(props.update.kind, L)}
      </button>
      <div style={{ display: 'flex', width: '100%' }}>
        <button type="button" onClick={props.onSkip} style={SECONDARY_STYLE}>{L.updateSkipVersion}</button>
        <button type="button" onClick={props.onDismiss} style={SECONDARY_STYLE}>{L.updateLater}</button>
      </div>
    </div>
  );
}

export function MAppUpdateDialog(props: MAppUpdateDialogProps) {
  const L = useVocab();
  return (
    <MUpdateFrame
      title={L.updateReady}
      summary={appUpdateSummaryLine(props.update, L)}
      description={installDescription(props.update.kind, L)}
    >
      {props.error ? (
        <div style={{ fontSize: 12, color: 'var(--proto-danger)', marginBottom: 10, textAlign: 'center' }}>
          {L.updateInstallFailed.replace('{error}', props.error)}
        </div>
      ) : null}
      <MAppUpdateActions {...props} />
    </MUpdateFrame>
  );
}
