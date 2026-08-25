// input:  acquire/release calls from browser-enabled sessions
// output: a live CDP endpoint backed by one long-running Chrome, shared by all of them
// pos:    Managed browser lifecycle; the only place Chrome is spawned
// >>> If I am updated, update CORTEX.md <<<

import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { DATA_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { resolveBrowserDisplay, probeHasBinary, type BrowserDisplay } from './display.js';

const log = createLogger('managed-browser');

/** One Chrome for the whole server, not one per session (plan/embedded-browser.md §16.6).
 *  A shared instance is what makes the profile — and therefore the logins the user performed by
 *  hand — visible to every agent that asks for a browser. Per-session Chromes would each start
 *  logged out, which is precisely the problem the managed instance exists to solve. */
const PROFILE_DIR = path.join(DATA_DIR, 'browser', 'profile');
const PREFERRED_CDP_PORT = 9222;
/** Chrome is heavy to start (~1s) but idle-cheap; reclaim slowly so back-to-back sessions reuse it. */
const IDLE_RECLAIM_MS = 10 * 60 * 1000;
const READY_TIMEOUT_MS = 30_000;
/** More crashes than this in the window means Chrome cannot run here at all — stop flapping. */
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;

export interface ManagedBrowser {
  /** What `@playwright/mcp --cdp-endpoint` receives. */
  cdpEndpoint: string;
  port: number;
  display: BrowserDisplay;
  pid: number;
}

interface Instance extends ManagedBrowser {
  proc: ChildProcess;
  xvfb?: ChildProcess;
}

let instance: Instance | null = null;
let starting: Promise<ManagedBrowser> | null = null;
let refs = 0;
let idleTimer: NodeJS.Timeout | null = null;
let restartTimes: number[] = [];

/**
 * Can this backend actually receive the browser tools?
 *
 * All three spawn paths compose it now, by three different routes: Claude print and Claude TUI both
 * append a `--mcp-config` file, and PI writes the same server descriptor into the envelope its MCP
 * bridge reads. The check stays rather than becoming `true` because the cost of getting it wrong is
 * asymmetric — starting Chrome for a backend that cannot drive it burns a browser nobody can use
 * and leaves the user staring at a window their agent cannot see.
 */
/** The device name meaning "this host". Kept next to the local browser rather than in the remote
 *  domain, because it is precisely the value that means "no device is involved". */
export const BROWSER_DEVICE_SERVER = 'server';

export function backendSupportsBrowser(backend: string, _claudeBackend?: string | null): boolean {
  return backend === 'claude' || backend === 'pi';
}

/** Acquire the shared browser, starting it on first use. Every caller MUST pair this with
 *  {@link releaseBrowser} — the refcount is what keeps Chrome alive. */
export async function acquireBrowser(): Promise<ManagedBrowser> {
  refs++;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  try {
    return await ensureStarted();
  } catch (e) {
    refs--; // a failed acquire must not pin a browser that never existed
    throw e;
  }
}

export function releaseBrowser(): void {
  if (refs === 0) return;
  refs--;
  if (refs === 0) scheduleIdleReclaim();
}

export function browserStatus(): { running: boolean; refs: number; browser: ManagedBrowser | null } {
  return {
    running: !!instance,
    refs,
    browser: instance
      ? { cdpEndpoint: instance.cdpEndpoint, port: instance.port, display: instance.display, pid: instance.pid }
      : null,
  };
}

/** Shut the browser down regardless of refcount (server shutdown). */
export function stopBrowser(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  refs = 0;
  kill();
}

function scheduleIdleReclaim(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (refs === 0) {
      log.info('no browser sessions left — reclaiming Chrome');
      kill();
    }
  }, IDLE_RECLAIM_MS);
  idleTimer.unref?.();
}

function kill(): void {
  const inst = instance;
  instance = null;
  if (!inst) return;
  try {
    inst.proc.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  try {
    inst.xvfb?.kill('SIGTERM');
  } catch {
    /* already gone */
  }
}

async function ensureStarted(): Promise<ManagedBrowser> {
  if (instance) return instance;
  if (starting) return starting; // concurrent acquires must not race two Chromes onto one profile
  starting = launch()
    .catch((e) => {
      throw e;
    })
    .finally(() => {
      starting = null;
    });
  return starting;
}

async function launch(): Promise<ManagedBrowser> {
  const exe = resolveChromeBinary();
  if (!exe) {
    throw new Error(
      'no Chrome/Chromium found — install Google Chrome, or set CORTEX_BROWSER_BINARY to its path',
    );
  }
  const display = resolveBrowserDisplay();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let xvfb: ChildProcess | undefined;
  let displayName = display.display;
  if (display.mode === 'virtual') {
    const started = startXvfb();
    xvfb = started.proc;
    displayName = started.display;
  }

  const port = await pickPort(PREFERRED_CDP_PORT);
  const args = [
    `--remote-debugging-port=${port}`,
    // Chrome 136+ refuses remote debugging on the default profile, so a dedicated dir is mandatory,
    // not a preference.
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    // Bind the debugging socket to loopback only: it is an unauthenticated remote-control channel.
    '--remote-debugging-address=127.0.0.1',
  ];
  if (display.mode === 'headless') args.push('--headless=new');

  const env = { ...process.env };
  if (displayName) env.DISPLAY = displayName;
  else delete env.DISPLAY;

  log.info(`launching ${exe} on port ${port} (${display.mode}${displayName ? ` ${displayName}` : ''})`);
  const proc = spawn(exe, args, { env, stdio: 'ignore', detached: false });
  proc.on('exit', (code, signal) => onExit(proc, code, signal));
  proc.on('error', (e) => log.error(`Chrome failed to spawn: ${e.message}`));

  try {
    await waitForCdp(port);
  } catch (e) {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    xvfb?.kill('SIGTERM');
    throw e;
  }

  instance = {
    cdpEndpoint: `http://127.0.0.1:${port}`,
    port,
    display: { ...display, display: displayName },
    pid: proc.pid ?? -1,
    proc,
    xvfb,
  };
  log.info(`Chrome ready at ${instance.cdpEndpoint} (pid ${instance.pid})`);
  return instance;
}

function onExit(proc: ChildProcess, code: number | null, signal: string | null): void {
  if (!instance || instance.proc !== proc) return; // a kill() we asked for
  log.warn(`Chrome exited (code=${code} signal=${signal})`);
  instance.xvfb?.kill('SIGTERM');
  instance = null;
  if (refs === 0) return;

  const now = Date.now();
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
  if (restartTimes.length >= MAX_RESTARTS_PER_WINDOW) {
    log.error('Chrome crashed repeatedly — giving up until the next acquire');
    restartTimes = [];
    return;
  }
  restartTimes.push(now);
  log.info(`${refs} session(s) still need a browser — restarting`);
  void ensureStarted().catch((e) => log.error(`restart failed: ${String(e)}`));
}

/** Start a virtual display. Only reached when Xvfb exists (the decision function checked). */
function startXvfb(): { proc: ChildProcess; display: string } {
  const display = `:${99 + Math.floor(Math.random() * 100)}`;
  const proc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], {
    stdio: 'ignore',
  });
  proc.on('error', (e) => log.error(`Xvfb failed: ${e.message}`));
  return { proc, display };
}

export function resolveChromeBinary(env = process.env): string | null {
  if (env.CORTEX_BROWSER_BINARY) {
    return fs.existsSync(env.CORTEX_BROWSER_BINARY) ? env.CORTEX_BROWSER_BINARY : null;
  }
  const absolute =
    process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ]
      : process.platform === 'win32'
        ? [
            `${env['ProgramFiles'] ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
            `${env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
            `${env['LOCALAPPDATA'] ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
          ]
        : [];
  for (const p of absolute) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* keep looking */
    }
  }
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    if (probeHasBinary(bin)) return bin;
  }
  return null;
}

/** Prefer the conventional 9222 so a human can point their own tools at it; fall back if taken. */
async function pickPort(preferred: number): Promise<number> {
  if (await isFree(preferred)) return preferred;
  for (let p = preferred + 1; p < preferred + 20; p++) {
    if (await isFree(p)) return p;
  }
  throw new Error(`no free CDP port near ${preferred}`);
}

function isFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** Chrome writes the port file asynchronously; poll the endpoint instead of guessing a delay. */
async function waitForCdp(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Chrome did not expose CDP on ${port} within ${READY_TIMEOUT_MS}ms (${lastError})`);
}

export const __test = { PROFILE_DIR, PREFERRED_CDP_PORT, IDLE_RECLAIM_MS };
