// input:  the pinned @earendil-works/pi-coding-agent dependency, home directory
// output: one cached in-process handle to the PI SDK module (prewarmable), its version, PI's user agent paths
// pos:    Single import boundary between agent-server and the PI SDK
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import * as os from 'node:os';
import * as path from 'node:path';
import type * as PiSdk from '@earendil-works/pi-coding-agent';
import { createLogger } from './log.js';

const log = createLogger('pi-sdk');

/** Static type of the PI SDK entry module (`@earendil-works/pi-coding-agent`). */
export type PiSdkModule = typeof PiSdk;

let loading: Promise<PiSdkModule> | undefined;

/**
 * Import the PI SDK once per process and share the promise.
 *
 * The SDK entry pulls in every provider client and the TUI (~100 MB RSS, seconds of module
 * loading), so nothing imports it statically: CLI commands that never touch PI keep their
 * startup, and the daemon pays the cost on the first PI session or provider scan.
 */
export function loadPiSdk(): Promise<PiSdkModule> {
  loading ??= import('@earendil-works/pi-coding-agent');
  return loading;
}

/**
 * Start the import in the background so no session waits for it.
 *
 * The module graph is ~11 MB of JavaScript and measures 15-20 s to evaluate on a loaded host;
 * without this the first PI session after a restart pays all of it before its first token, and
 * every later session pays nothing. Safe to call when no PI session ever happens: the cost is the
 * import itself, and a failure only means the first session imports it again and reports the real
 * error there.
 */
export function prewarmPiSdk(): void {
  const startedAt = Date.now();
  void loadPiSdk()
    .then(() => log.info(`PI SDK preloaded in ${Date.now() - startedAt}ms`))
    .catch((error: unknown) => log.warn(
      `PI SDK preload failed; the first PI session will surface the error: ${(error as Error).message}`,
    ));
}

/** Pinned PI SDK version, read from the module once it is loaded. */
export async function piSdkVersion(): Promise<string> {
  return (await loadPiSdk()).VERSION;
}

/**
 * The bundled PI CLI entry (`<package>/dist/cli.js`), for the child processes Cortex still runs
 * through PI's command line. Resolved from the loaded SDK so it always matches the pinned version
 * and never depends on a `pi` binary on PATH.
 */
export async function piCliPath(): Promise<string> {
  return path.join((await loadPiSdk()).getPackageDir(), 'dist', 'cli.js');
}

/**
 * PI's own agent directory (`~/.pi/agent`). Its auth.json and models.json are shared with a
 * separately installed `pi` CLI, so login state and user-defined providers are discovered here
 * rather than in Cortex's private PI agent directory.
 */
export function piUserAgentDir(): string {
  return path.join(os.homedir(), '.pi', 'agent');
}

export function piUserAuthPath(): string {
  return path.join(piUserAgentDir(), 'auth.json');
}

export function piUserModelsPath(): string {
  return path.join(piUserAgentDir(), 'models.json');
}
