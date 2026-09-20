import type { SystemUpdateStatus } from '@cortex-agent/ui-contract';
import { DesktopUpdateFrame } from '@/design/DesktopUpdateFrame';

// Copy is local to this dialog, the way app-update/app-update.ts keeps its own strings: these
// sentences describe one flow and are never reused, so a shared vocab entry would only add a hop.

const GHOST_BTN_CLASS =
  'box-border flex h-9 items-center rounded-[9px] border border-proto-line px-4 text-[12.5px] ' +
  'font-semibold text-proto-muted transition-colors hover:bg-surface-canvas-alt ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40';

const PRIMARY_BTN_CLASS =
  'box-border flex h-9 items-center rounded-[9px] bg-state-ink px-4 text-[12.5px] font-semibold ' +
  'text-surface-card transition-opacity hover:opacity-90 disabled:opacity-60 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-state-run/40';

export interface ServerUpdateDialogProps {
  status: SystemUpdateStatus;
  busy: boolean;
  onApply: () => void;
  onSkip: () => void;
  onDismiss: () => void;
}

/** Mono meta line under the title. */
export function serverUpdateSummaryLine(status: SystemUpdateStatus): string {
  const version = status.available ?? '';
  return version ? `Cortex ${version} · 服务端 + 应用` : 'Cortex · 服务端 + 应用';
}

export function serverUpdateTitle(state: SystemUpdateStatus['state']): string {
  switch (state) {
    case 'installing': return '正在更新服务端';
    case 'restarting': return '正在重启服务端';
    case 'failed': return '服务端更新失败';
    default: return '新版本可用';
  }
}

export function serverUpdateDescription(status: SystemUpdateStatus): string {
  const version = status.available ?? '新版本';
  switch (status.state) {
    case 'installing':
      return `正在安装服务端 ${version}，请勿关闭。安装完成后服务端会在空闲时自动重启，运行中的线程不会被打断。`;
    case 'restarting':
      return '服务端已安装完成，正在等待空闲后重启。重启回来后 App 会自动下载新版本外壳，并在你下次退出时装好——不需要再确认一次。';
    case 'failed':
      return '这次自动更新没有完成。服务端仍在运行旧版本，下一次例行检查会重新提示；也可以手动执行 npm install -g @cortex-agent/server@latest。';
    default:
      return `服务端与 App 将一起更新到 ${version}。点击更新后：服务端自行安装并重启，App 在后台下载新版本、下次退出时装好。全程只需这一次确认。`;
  }
}

function ServerUpdateActions(props: ServerUpdateDialogProps) {
  if (props.status.state === 'prompting') {
    return (
      <div className="flex justify-end gap-2">
        <button type="button" onClick={props.onSkip} disabled={props.busy} className={GHOST_BTN_CLASS}>
          跳过此版本
        </button>
        <button type="button" onClick={props.onDismiss} className={GHOST_BTN_CLASS}>
          稍后
        </button>
        <button type="button" onClick={props.onApply} disabled={props.busy} className={PRIMARY_BTN_CLASS}>
          {props.busy ? '正在处理…' : '更新'}
        </button>
      </div>
    );
  }
  // installing / restarting / failed: the work is already underway (or over) server-side, so the
  // only thing left to offer is getting the dialog out of the way.
  return (
    <div className="flex justify-end gap-2">
      <button type="button" onClick={props.onDismiss} className={GHOST_BTN_CLASS}>
        {props.status.state === 'failed' ? '关闭' : '后台继续'}
      </button>
    </div>
  );
}

export function ServerUpdateDialog(props: ServerUpdateDialogProps) {
  const inFlight = props.status.state === 'installing' || props.status.state === 'restarting';
  return (
    <DesktopUpdateFrame
      title={serverUpdateTitle(props.status.state)}
      summary={serverUpdateSummaryLine(props.status)}
      descriptionId="server-update-desc"
      description={serverUpdateDescription(props.status)}
      onDismiss={props.onDismiss}
    >
      {inFlight ? (
        <div className="mb-3 flex items-center gap-2 text-[11.5px] leading-snug text-proto-muted">
          <span className="h-1.5 w-1.5 flex-none animate-pulse rounded-full bg-state-run" />
          {props.status.state === 'installing' ? 'npm install -g @cortex-agent/server@latest' : '等待服务端回到线上…'}
        </div>
      ) : null}
      {props.status.error ? (
        <pre className="mb-3 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-[9px] bg-surface-canvas-alt p-2 font-mono text-[10.5px] leading-snug text-state-fail">
          {props.status.error}
        </pre>
      ) : null}
      <ServerUpdateActions {...props} />
    </DesktopUpdateFrame>
  );
}
