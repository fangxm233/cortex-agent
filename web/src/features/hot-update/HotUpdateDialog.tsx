// input:  staged frontend update metadata and decision callbacks
// output: current desktop hot-update content inside the desktop-only frame
// pos:    Desktop dialog for staged frontend updates
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { DesktopUpdateFrame } from '@/features/update/DesktopUpdateFrame';
import { updateSummaryLine, type StagedUpdate } from './frontend-update';

export interface HotUpdateDialogProps {
  update: StagedUpdate;
  onApply: () => void;
  onDismiss: () => void;
}

function HotUpdateActions(props: Pick<HotUpdateDialogProps, 'onApply' | 'onDismiss'>) {
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={props.onDismiss}
        className="box-border flex h-9 items-center rounded-[9px] border border-proto-line px-4 text-[12.5px] font-semibold text-proto-muted transition-colors hover:bg-surface-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
      >
        忽略
      </button>
      <button
        type="button"
        onClick={props.onApply}
        className="box-border flex h-9 items-center rounded-[9px] bg-state-ink px-4 text-[12.5px] font-semibold text-surface-card transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
      >
        重启 App
      </button>
    </div>
  );
}

export function HotUpdateDialog(props: HotUpdateDialogProps) {
  return (
    <DesktopUpdateFrame
      title="新版本已就绪"
      summary={updateSummaryLine(props.update)}
      descriptionId="hot-update-desc"
      description="热更新已在后台下载完成，重启 App 后生效。运行中的线程在服务端继续执行，不受重启影响；未发送的草稿会保留。"
      onDismiss={props.onDismiss}
    >
      <HotUpdateActions onApply={props.onApply} onDismiss={props.onDismiss} />
    </DesktopUpdateFrame>
  );
}
