// input:  app-update metadata, copy helpers, and decision callbacks
// output: current desktop shell-update content inside the desktop-only frame
// pos:    Desktop dialog for native application updates
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { DesktopUpdateFrame } from '@/features/update/DesktopUpdateFrame';
import {
  appUpdateSummaryLine,
  installCtaLabel,
  installDescription,
  type AppUpdateInfo,
} from './app-update';

const GHOST_BTN_CLASS =
  'box-border flex h-9 items-center rounded-[9px] border border-proto-line px-4 text-[12.5px] ' +
  'font-semibold text-proto-muted transition-colors hover:bg-surface-canvas-alt ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40';

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
    <div className="flex justify-end gap-2">
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
        className="box-border flex h-9 items-center rounded-[9px] bg-state-ink px-4 text-[12.5px] font-semibold text-surface-card transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
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
