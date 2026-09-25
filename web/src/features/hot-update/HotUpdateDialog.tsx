// input:  DesktopUpdateFrame, staged update and action callbacks
// output: HotUpdateDialog
// pos:    Frontend update prompt with material controls
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { DesktopUpdateFrame } from '@/design/DesktopUpdateFrame';
import { updateSummaryLine, type StagedUpdate } from './frontend-update';

export interface HotUpdateDialogProps {
  update: StagedUpdate;
  onApply: () => void;
  onDismiss: () => void;
}

function HotUpdateActions(props: Pick<HotUpdateDialogProps, 'onApply' | 'onDismiss'>) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button
        type="button"
        onClick={props.onDismiss}
        className="box-border flex h-9 items-center rounded-[var(--r-control)] border border-proto-line [background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] px-4 text-[12.5px] font-semibold text-proto-muted transition-colors hover:bg-surface-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent"
      >
        忽略
      </button>
      <button
        type="button"
        onClick={props.onApply}
        className="box-border flex h-9 items-center rounded-[var(--r-control)] bg-state-ink px-4 text-[12.5px] font-semibold text-[var(--ink-solid-fg)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent"
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
