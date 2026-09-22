// input:  DesktopUpdateFrame, app update info and action callbacks
// output: AppUpdateDialog
// pos:    App update prompt presentation and install controls
// >>> Once I am updated, be sure to update my header comment and the parent folder AGENTS.md <<<
import { DesktopUpdateFrame } from '@/features/update/DesktopUpdateFrame';
import {
  appUpdateSummaryLine,
  installCtaLabel,
  installDescription,
  type AppUpdateInfo,
} from './app-update';

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
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <button type="button" onClick={props.onSkip} className={GHOST_BTN_CLASS}>
        跳过此版本
      </button>
      <button type="button" onClick={props.onDismiss} className={GHOST_BTN_CLASS}>
        稍后
      </button>
      <button
        type="button"
        onClick={props.onInstall}
        disabled={props.busy}
        className="box-border flex h-9 items-center rounded-[var(--r-control)] bg-state-ink [background-image:var(--material-sheen)] px-4 text-[12.5px] font-semibold text-[var(--ink-solid-fg)] transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proto-accent"
      >
        {props.busy ? '正在处理…' : installCtaLabel(props.update.kind)}
      </button>
    </div>
  );
}

export function AppUpdateDialog(props: AppUpdateDialogProps) {
  return (
    <DesktopUpdateFrame
      title="App 新版本已就绪"
      summary={appUpdateSummaryLine(props.update)}
      descriptionId="app-update-desc"
      description={installDescription(props.update.kind)}
      onDismiss={props.onDismiss}
    >
      {props.error ? (
        <div className="mb-3 text-[11.5px] leading-snug text-state-fail">安装失败：{props.error}</div>
      ) : null}
      <AppUpdateActions {...props} />
    </DesktopUpdateFrame>
  );
}
