import * as RadixDialog from '@radix-ui/react-dialog';
import {
  appUpdateSummaryLine,
  installCtaLabel,
  installDescription,
  type AppUpdateInfo,
} from './app-update';

// Desktop app shell update prompt — same 420px modal grammar as the hot-update dialog (21a), with
// per-kind CTA + copy: the flow differs per package (AppImage restarts itself, NSIS hands off to
// the installer, dmg/deb/rpm open an installer file). Esc / overlay click = 稍后 (this run only);
// 跳过此版本 persists shell-side. Presentational — useAppUpdate owns state and actions.

const OVERLAY_CLASS =
  'fixed inset-0 z-40 bg-state-ink/[0.44] ' +
  'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none';

const CONTENT_CLASS =
  'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 ' +
  'w-[420px] max-w-[calc(100vw-32px)] box-border ' +
  'rounded-[14px] bg-surface-card p-5 pb-4 shadow-overlay-strong focus:outline-none ' +
  'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out motion-reduce:animate-none';

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

export function AppUpdateDialog({
  update, busy, error, onInstall, onSkip, onDismiss,
}: AppUpdateDialogProps) {
  return (
    <RadixDialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY_CLASS} />
        <RadixDialog.Content className={CONTENT_CLASS} aria-describedby="app-update-desc">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-card bg-proto-accent-bg text-state-run">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M10 14V4M5.5 8.5 10 4l4.5 4.5" />
                <path d="M3.5 16.5h13" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-body font-semibold text-state-ink">
                App 新版本已就绪
              </RadixDialog.Title>
              <div className="mt-[3px] font-mono text-[10.5px] font-medium text-proto-muted-3">
                {appUpdateSummaryLine(update)}
              </div>
            </div>
          </div>

          <RadixDialog.Description
            id="app-update-desc"
            className="mb-4 mt-3 text-[12.5px] leading-[1.65] text-proto-muted"
          >
            {installDescription(update.kind)}
          </RadixDialog.Description>

          {error ? (
            <div className="mb-3 text-[11.5px] leading-snug text-state-fail">安装失败：{error}</div>
          ) : null}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onSkip} className={GHOST_BTN_CLASS}>
              跳过此版本
            </button>
            <button type="button" onClick={onDismiss} className={GHOST_BTN_CLASS}>
              稍后
            </button>
            <button
              type="button"
              onClick={onInstall}
              disabled={busy}
              className="box-border flex h-9 items-center rounded-[9px] bg-state-ink px-4 text-[12.5px] font-semibold text-surface-card transition-opacity hover:opacity-90 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
            >
              {busy ? '正在处理…' : installCtaLabel(update.kind)}
            </button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
