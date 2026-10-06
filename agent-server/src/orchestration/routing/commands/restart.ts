//
// The daemon (entry/daemon.ts) watches STORE_DIR/.restart and, on seeing it, unlinks the
// file and respawns the app.ts child from the freshly installed dist (busy/idle-gated, so a
// mid-flight turn is never interrupted). Restart therefore only works when running under the
// daemon supervisor — if no live daemon is detected we report that instead of silently
// writing a trigger nobody watches. The TUI's WS connection drops during the respawn and
// reconnects automatically.

import type { PlatformAdapter } from '@platform/index.js';
import { DAEMON_PID_FILE } from '@core/paths.js';
import { readLivePid, touchRestartTrigger } from '@core/singleton-lock.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { CommandResult } from './command-context.js';

export interface RestartDeps {
  /** The live daemon's pid, or null when no daemon is running. */
  livePid: () => number | null;
  /** Create/refresh the .restart trigger file. */
  touch: () => void;
}

export interface RestartOutcome {
  ok: boolean;
  messageKey: 'triggered' | 'noDaemon';
}

/**
 * Decide and perform a server restart: only writes the .restart trigger when a live daemon
 * is present to act on it. Pure but for the injected side effects, so it is unit-testable.
 */
export function triggerServerRestart(deps: RestartDeps): RestartOutcome {
  if (deps.livePid() === null) return { ok: false, messageKey: 'noDaemon' };
  deps.touch();
  return { ok: true, messageKey: 'triggered' };
}

export async function handleRestartCmd(
  _channel: string,
  _adapter: PlatformAdapter,
  _trimmedMessage: string,
): Promise<CommandResult> {
  const outcome = triggerServerRestart({
    livePid: () => readLivePid(DAEMON_PID_FILE),
    touch: () => touchRestartTrigger(),
  });

  if (!outcome.ok) {
    return { text: `${Icons.error} ${t('cmd.restart.noDaemon')}` };
  }
  return { text: `${Icons.refresh} ${t('cmd.restart.triggered')}` };
}
