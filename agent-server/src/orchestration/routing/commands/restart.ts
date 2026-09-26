//
// The daemon (entry/daemon.ts) watches STORE_DIR/.restart and, on seeing it, unlinks the
// file and respawns the app.ts child from the freshly installed dist (busy/idle-gated, so a
// mid-flight turn is never interrupted). Restart therefore only works when running under the
// daemon supervisor — if no live daemon is detected we report that instead of silently
// writing a trigger nobody watches. The TUI's WS connection drops during the respawn and
// reconnects automatically.

import { readFileSync, writeFileSync } from 'fs';
import * as path from 'path';
import type { PlatformAdapter } from '@platform/index.js';
import { STORE_DIR } from '@core/utils.js';
import { isProcessAlive } from '@core/singleton-lock.js';
import { Icons } from '../../../core/icons.js';
import { t } from '../../../core/i18n.js';
import type { CommandResult } from './command-context.js';

export interface RestartDeps {
  /** Directory holding daemon.pid and the .restart trigger (STORE_DIR in production). */
  storeDir: string;
  /** Read the daemon's pid from its pidfile, or null if absent/unparseable. */
  readPid: (pidFile: string) => number | null;
  /** Whether a process with the given pid is alive. */
  isAlive: (pid: number) => boolean;
  /** Create/refresh the .restart trigger file. */
  touch: (file: string) => void;
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
  const pid = deps.readPid(path.join(deps.storeDir, 'daemon.pid'));
  if (pid === null || !deps.isAlive(pid)) {
    return { ok: false, messageKey: 'noDaemon' };
  }
  deps.touch(path.join(deps.storeDir, '.restart'));
  return { ok: true, messageKey: 'triggered' };
}

function readDaemonPid(pidFile: string): number | null {
  try {
    const n = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export async function handleRestartCmd(
  _channel: string,
  _adapter: PlatformAdapter,
  _trimmedMessage: string,
): Promise<CommandResult> {
  const outcome = triggerServerRestart({
    storeDir: STORE_DIR,
    readPid: readDaemonPid,
    isAlive: isProcessAlive,
    touch: (file) => writeFileSync(file, String(Date.now()), 'utf8'),
  });

  if (!outcome.ok) {
    return { text: `${Icons.error} ${t('cmd.restart.noDaemon')}` };
  }
  return { text: `${Icons.refresh} ${t('cmd.restart.triggered')}` };
}
