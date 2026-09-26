import { useVocab } from '@/i18n';
import type { CSSProperties } from 'react';
import { updateSummaryLine, type StagedUpdate } from '@/features/hot-update/frontend-update';
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
  color: 'var(--proto-muted-2)', cursor: 'pointer', width: '100%',
};

export interface MHotUpdateDialogProps {
  update: StagedUpdate;
  onApply: () => void;
  onDismiss: () => void;
}

function MHotUpdateActions(props: Pick<MHotUpdateDialogProps, 'onApply' | 'onDismiss'>) {
  const L = useVocab();
  return (
    <div style={ACTIONS_STYLE}>
      <button type="button" onClick={props.onApply} style={PRIMARY_STYLE}>{L.updateExitApp}</button>
      <button type="button" onClick={props.onDismiss} style={SECONDARY_STYLE}>{L.updateIgnore}</button>
    </div>
  );
}

export function MHotUpdateDialog(props: MHotUpdateDialogProps) {
  const L = useVocab();
  return (
    <MUpdateFrame
      title={L.updateReady}
      summary={updateSummaryLine(props.update, L)}
      description={L.updateHotHint}
    >
      <MHotUpdateActions onApply={props.onApply} onDismiss={props.onDismiss} />
    </MUpdateFrame>
  );
}
