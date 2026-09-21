import type { PlatformAdapter } from '@platform/index.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';
import { holdNewTurns, releaseNewTurnHold } from '@domain/system/rebuild-hold.js';

/** Messages the daemon supervisor pushes DOWN to the running app over the fork IPC channel.
 *  The reverse direction (busy/idle) is owned by orchestration/busy-tracker. */
export interface DaemonMessage {
  type?: string;
  text?: string;
  /** 'rebuild-hold': whether new turns must be refused. */
  hold?: boolean;
  /** 'rebuild-hold': the pipeline step in flight, when the supervisor named one. */
  phase?: string | null;
  /** 'rebuild-hold': what triggered the rebuild. */
  reason?: string | null;
}

/** Broadcast a supervisor-side notice to the admin channel and the Web toaster.
 *
 *  Returns whether a notice was emitted, so an unrelated IPC message is distinguishable from a
 *  handled one. A rebuild abort is error-level on purpose: the pipeline stopped before
 *  install+restart, so the process stays on the previously installed build and every later code
 *  change is invisible until someone notices. Logging alone made that failure silent. */
export async function handleDaemonMessage(
  msg: DaemonMessage | undefined | null,
  adapter: PlatformAdapter,
): Promise<boolean> {
  // Admission control. Silent on purpose: the operator hears about a rebuild through the daemon page
  // and through the abort notice, and a toast per phase would be noise. Handled without a notice, so
  // it returns before the notice branch below.
  if (msg?.type === 'rebuild-hold') {
    if (msg.hold) holdNewTurns({ phase: msg.phase ?? null, reason: msg.reason ?? null });
    else releaseNewTurnHold();
    return true;
  }
  if (msg?.type !== 'rebuild-aborted' || !msg.text) return false;
  await emitSystemNotice(adapter, { level: 'error', title: 'Rebuild', text: msg.text });
  return true;
}

/** Wire the fork IPC channel to the notice broadcast. No-op when the process was not forked by
 *  the daemon (standalone `cortex serve`, tests), where `process.send` is undefined.
 *
 *  `disconnect` lifts any hold: the supervisor that asked for it is gone, so nothing is going to
 *  restart this process and refusing work would only strand the operator. */
export function subscribeDaemonNotices(adapter: PlatformAdapter): void {
  if (!process.send) return;
  process.on('message', (msg) => {
    void handleDaemonMessage(msg as DaemonMessage, adapter).catch(() => {});
  });
  process.on('disconnect', () => { releaseNewTurnHold(); });
}
