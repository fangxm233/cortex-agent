// input:  daemon fork IPC messages, PlatformAdapter
// output: handleDaemonMessage + subscribeDaemonNotices
// pos:    entry/ layer — turns supervisor-side notices into admin/system broadcasts
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import type { PlatformAdapter } from '@platform/index.js';
import { emitSystemNotice } from '@domain/system/system-notice.js';

/** Messages the daemon supervisor pushes DOWN to the running app over the fork IPC channel.
 *  The reverse direction (busy/idle) is owned by orchestration/busy-tracker. */
export interface DaemonMessage {
  type?: string;
  text?: string;
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
  if (msg?.type !== 'rebuild-aborted' || !msg.text) return false;
  await emitSystemNotice(adapter, { level: 'error', title: 'Rebuild', text: msg.text });
  return true;
}

/** Wire the fork IPC channel to the notice broadcast. No-op when the process was not forked by
 *  the daemon (standalone `cortex serve`, tests), where `process.send` is undefined. */
export function subscribeDaemonNotices(adapter: PlatformAdapter): void {
  if (!process.send) return;
  process.on('message', (msg) => {
    void handleDaemonMessage(msg as DaemonMessage, adapter).catch(() => {});
  });
}
