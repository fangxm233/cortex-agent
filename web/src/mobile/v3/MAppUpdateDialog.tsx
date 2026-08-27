// input:  app-update metadata, copy helpers, and decision callbacks
// output: current mobile shell-update content inside the mobile-only frame
// pos:    Mobile dialog for native application updates
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

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
  height: 48, border: 'none', borderRadius: 13, background: 'var(--proto-ink)',
  color: 'var(--ink-solid-fg)', display: 'flex', alignItems: 'center',
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
  return (
    <div style={ACTIONS_STYLE}>
      <button
        type="button"
        onClick={props.onInstall}
        disabled={props.busy}
        style={{ ...PRIMARY_STYLE, opacity: props.busy ? 0.6 : 1 }}
      >
        {props.busy ? '正在处理…' : installCtaLabel(props.update.kind)}
      </button>
      <div style={{ display: 'flex', width: '100%' }}>
        <button type="button" onClick={props.onSkip} style={SECONDARY_STYLE}>跳过此版本</button>
        <button type="button" onClick={props.onDismiss} style={SECONDARY_STYLE}>稍后</button>
      </div>
    </div>
  );
}

export function MAppUpdateDialog(props: MAppUpdateDialogProps) {
  return (
    <MUpdateFrame
      title="App 新版本已就绪"
      summary={appUpdateSummaryLine(props.update)}
      description={installDescription(props.update.kind)}
    >
      {props.error ? (
        <div style={{ fontSize: 12, color: 'var(--proto-danger)', marginBottom: 10, textAlign: 'center' }}>
          安装失败：{props.error}
        </div>
      ) : null}
      <MAppUpdateActions {...props} />
    </MUpdateFrame>
  );
}
