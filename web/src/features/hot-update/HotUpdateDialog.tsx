import * as RadixDialog from '@radix-ui/react-dialog';
import { updateSummaryLine, type StagedUpdate } from './frontend-update';

// Desktop hot-update prompt — 1:1 rebuild of scheme.dc.html §21a (热更新弹窗). A 420px centered modal
// over the workbench (overlay ink 44%): run-blue icon square + title「新版本已就绪」+ Plex Mono version
// line + reassurance copy + right-aligned「忽略」ghost /「重启 App」ink buttons. Esc / overlay click =
// 忽略 (design 21a). Token-only (zero hex): colors come from tailwind tokens.
//
// Presentational — the provider owns the staged update + apply/dismiss wiring.

const OVERLAY_CLASS =
  'fixed inset-0 z-40 bg-state-ink/[0.44] ' +
  'data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out motion-reduce:animate-none';

const CONTENT_CLASS =
  'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 ' +
  'w-[420px] max-w-[calc(100vw-32px)] box-border ' +
  'rounded-[14px] bg-surface-card p-5 pb-4 shadow-overlay-strong focus:outline-none ' +
  'data-[state=open]:animate-zoom-in data-[state=closed]:animate-zoom-out motion-reduce:animate-none';

export interface HotUpdateDialogProps {
  update: StagedUpdate;
  onApply: () => void;
  onDismiss: () => void;
}

export function HotUpdateDialog({ update, onApply, onDismiss }: HotUpdateDialogProps) {
  return (
    <RadixDialog.Root
      open
      onOpenChange={(next) => {
        // Esc / overlay click / any close request = 忽略 (design 21a).
        if (!next) onDismiss();
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={OVERLAY_CLASS} />
        <RadixDialog.Content className={CONTENT_CLASS} aria-describedby="hot-update-desc">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 flex-none items-center justify-center rounded-card bg-proto-accent-bg text-state-run">
              <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M10 14V4M5.5 8.5 10 4l4.5 4.5" />
                <path d="M3.5 16.5h13" />
              </svg>
            </div>
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className="text-body font-semibold text-state-ink">
                新版本已就绪
              </RadixDialog.Title>
              <div className="mt-[3px] font-mono text-[10.5px] font-medium text-proto-muted-3">
                {updateSummaryLine(update)}
              </div>
            </div>
          </div>

          <RadixDialog.Description
            id="hot-update-desc"
            className="mb-4 mt-3 text-[12.5px] leading-[1.65] text-proto-muted"
          >
            热更新已在后台下载完成，重启 App 后生效。运行中的线程在服务端继续执行，不受重启影响；未发送的草稿会保留。
          </RadixDialog.Description>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onDismiss}
              className="box-border flex h-9 items-center rounded-[9px] border border-proto-line px-4 text-[12.5px] font-semibold text-proto-muted transition-colors hover:bg-surface-canvas-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
            >
              忽略
            </button>
            <button
              type="button"
              onClick={onApply}
              className="box-border flex h-9 items-center rounded-[9px] bg-state-ink px-4 text-[12.5px] font-semibold text-surface-card transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40"
            >
              重启 App
            </button>
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
