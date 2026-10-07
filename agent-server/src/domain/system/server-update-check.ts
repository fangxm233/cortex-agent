import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { ServerUpdateCoordinator } from './server-update-coordinator.js';
import { runFile } from '@core/exec-async.js';
import { withServerNpmPrefix } from '@core/utils.js';
import type { UpdateChoice, UpdatePrompt } from './update-prompt.js';
import { loadUpdateState, saveUpdateState, type UpdateState } from './update-state.js';
import { ALWAYS_IDLE, createIdleInstaller, type IdleSignal } from './server-update-install.js';

// ── Dev mode detection ──────────────────────────────────────────
// In dev mode (CORTEX_REPO set), server auto-update is skipped entirely
// because the developer manages the install directly.

export function isUpdateDevMode(): boolean {
  const repo = process.env.CORTEX_REPO;
  if (!repo) return false;
  try {
    return fs.existsSync(repo) && fs.statSync(repo).isDirectory();
  } catch {
    return false;
  }
}

// ── Dependencies interface ──────────────────────────────────────

export interface CheckServerUpdateDeps {
  prompt: UpdatePrompt;
  /** May be async: the default implementation shells out to `npm view` without blocking. */
  getLatest?: () => string | null | Promise<string | null>;
  /** Install an agreed version once no turn is running. Overrides `idle`. */
  installWhenIdle?: (version: string) => void;
  /** When the server has no turn running; defaults to always idle. */
  idle?: IdleSignal;
  loadState?: () => UpdateState | null;
  saveState?: (s: UpdateState) => void;
  now?: () => string;
}

// ── Default implementations ─────────────────────────────────────

/** Async: `npm view` is a network round trip and must not stall the event loop (it used to run
 *  via execSync with a 15s timeout, on a timer that fires 60s after boot). */
async function defaultGetLatest(): Promise<string | null> {
  const result = await runFile('npm', ['view', '@cortex-agent/server', 'version'], {
    timeoutMs: 15000,
    // Outside any project checkout, so a local .npmrc cannot redirect the registry lookup.
    cwd: os.tmpdir(),
  });
  if (!result.ok) return null;
  const version = result.stdout.trim();
  return version || null;
}

/** Keep the reported stderr small enough to sit in a dialog and in the status snapshot. */
const INSTALL_STDERR_CAP = 2000;

function describeInstallFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr: string,
): string {
  const how = signal !== null ? `killed by ${signal}` : `exited with code ${code}`;
  const tail = stderr.trim().split('\n').slice(-6).join('\n').trim();
  return tail ? `npm install -g ${how}\n${tail}` : `npm install -g ${how}`;
}

/** Install exactly the version that was checked, into the prefix of the running install. */
function runNpmInstall(version: string, done: (error: string | null) => void): void {
  const child = spawn('npm', withServerNpmPrefix(['install', '-g', `@cortex-agent/server@${version}`]), {
    // Detached + unref'd: the package's postinstall touches $STORE_DIR/.restart and the daemon
    // respawns app.js, possibly before npm itself exits, so the install has to outlive this process.
    // stderr is piped so the SPA dialog can report a real failure.
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    cwd: '/tmp',
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer | string) => {
    if (stderr.length < INSTALL_STDERR_CAP) stderr += String(chunk);
  });
  // The pipe is a separate libuv handle from the child; unref it too so a still-running install
  // cannot hold this event loop open. Typed as Readable, but a spawned pipe is a net.Socket.
  (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();

  child.on('error', (err: Error) => done(`npm install -g could not start: ${err.message}`));
  child.on('exit', (code, signal) => done(code === 0 ? null : describeInstallFailure(code, signal, stderr)));

  child.unref();
}

function defaultNow(): string {
  return new Date().toISOString();
}

// ── Result type ─────────────────────────────────────────────────

export interface CheckServerUpdateResult {
  action: UpdateChoice | null;
  latestVersion: string | null;
}

// ── Shared runtime coordinator / legacy waiting wrapper ─────────

export function createServerUpdateCoordinator(deps: CheckServerUpdateDeps): ServerUpdateCoordinator {
  return new ServerUpdateCoordinator({
    prompt: deps.prompt,
    getLatest: deps.getLatest ?? defaultGetLatest,
    installWhenIdle: deps.installWhenIdle ?? createIdleInstaller(deps.idle ?? ALWAYS_IDLE, runNpmInstall),
    loadState: deps.loadState ?? loadUpdateState,
    saveState: deps.saveState ?? saveUpdateState,
    now: deps.now ?? defaultNow,
    isDevMode: isUpdateDevMode,
  });
}

/** Compatibility for callers that need the final choice. App timers/API share a coordinator. */
export function checkServerUpdate(deps: CheckServerUpdateDeps): Promise<CheckServerUpdateResult> {
  return createServerUpdateCoordinator(deps).checkAndWait();
}
