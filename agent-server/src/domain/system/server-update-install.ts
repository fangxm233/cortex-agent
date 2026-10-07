// An agreed server update is installed only while no turn is running. `npm install -g` rewrites
// the files this process loaded, and the package's postinstall then asks the daemon to restart it,
// so the install has to wait for idle and new turns are refused from the moment it starts until
// the restart: a turn admitted in between would run on half-replaced files and then be killed.

import { holdNewTurns, releaseNewTurnHold } from './rebuild-hold.js';
import {
  reportServerUpdateFailed, reportServerUpdateInstalled, reportServerUpdateInstalling,
} from './update-ui-state.js';

export interface IdleSignal {
  isIdle(): boolean;
  /** Called on every busy→idle transition; returns the unsubscribe. */
  onIdle(listener: () => void): () => void;
}

/** Start the install of `version`; call `done` once with null on success or an error message. */
export type InstallRunner = (version: string, done: (error: string | null) => void) => void;

export interface IdleInstallerOptions {
  /** True when a daemon will restart this process after the install. */
  supervised?: () => boolean;
  /** The turn hold is a lease; renew it while npm runs. */
  renewMs?: number;
}

const HOLD_PHASE = 'update';
const DEFAULT_RENEW_MS = 60_000;

export const ALWAYS_IDLE: IdleSignal = { isIdle: () => true, onIdle: () => () => {} };

/** Returns `installWhenIdle(version)`: installs now if idle, otherwise on the next idle transition. */
export function createIdleInstaller(
  idle: IdleSignal, run: InstallRunner, opts: IdleInstallerOptions = {},
): (version: string) => void {
  const supervised = opts.supervised ?? (() => Boolean(process.send));
  const renewMs = opts.renewMs ?? DEFAULT_RENEW_MS;
  let queued: string | null = null;
  let running = false;
  let unsubscribe: (() => void) | null = null;

  const finish = (renew: ReturnType<typeof setInterval>, error: string | null): void => {
    clearInterval(renew);
    running = false;
    if (error !== null) {
      releaseNewTurnHold();
      reportServerUpdateFailed(error);
      return;
    }
    reportServerUpdateInstalled();
    // The restart is the daemon's; without one nothing replaces this process, so stop refusing.
    if (supervised()) holdNewTurns({ phase: 'restart' });
    else releaseNewTurnHold();
  };

  const start = (): void => {
    if (running || queued === null || !idle.isIdle()) return;
    const version = queued;
    queued = null;
    unsubscribe?.();
    unsubscribe = null;
    running = true;
    holdNewTurns({ phase: HOLD_PHASE });
    const renew = setInterval(() => holdNewTurns({ phase: HOLD_PHASE }), renewMs);
    renew.unref?.();
    reportServerUpdateInstalling();
    let settled = false;
    const done = (error: string | null): void => {
      if (settled) return;
      settled = true;
      finish(renew, error);
    };
    try {
      run(version, done);
    } catch (error) {
      done(error instanceof Error ? error.message : String(error));
    }
  };

  return (version: string): void => {
    queued = version;
    if (idle.isIdle()) {
      start();
      return;
    }
    unsubscribe ??= idle.onIdle(start);
  };
}
