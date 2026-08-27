// input:  staged frontend update metadata and decision callbacks
// output: current mobile hot-update content inside the mobile-only frame
// pos:    Mobile dialog for staged frontend updates
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { CSSProperties } from 'react';
import { updateSummaryLine, type StagedUpdate } from '@/features/hot-update/frontend-update';
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
  color: 'var(--proto-muted-2)', cursor: 'pointer', width: '100%',
};

export interface MHotUpdateDialogProps {
  update: StagedUpdate;
  onApply: () => void;
  onDismiss: () => void;
}

function MHotUpdateActions(props: Pick<MHotUpdateDialogProps, 'onApply' | 'onDismiss'>) {
  return (
    <div style={ACTIONS_STYLE}>
      <button type="button" onClick={props.onApply} style={PRIMARY_STYLE}>退出 App</button>
      <button type="button" onClick={props.onDismiss} style={SECONDARY_STYLE}>忽略</button>
    </div>
  );
}

export function MHotUpdateDialog(props: MHotUpdateDialogProps) {
  return (
    <MUpdateFrame
      title="新版本已就绪"
      summary={updateSummaryLine(props.update)}
      description="热更新已在后台下载完成，重启 App 后生效。运行中的线程在服务端继续执行，不受重启影响。"
    >
      <MHotUpdateActions onApply={props.onApply} onDismiss={props.onDismiss} />
    </MUpdateFrame>
  );
}
