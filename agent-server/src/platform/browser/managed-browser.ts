import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import type { Readable } from 'stream';
import { DATA_DIR } from '@core/paths.js';
import { createLogger } from '@core/log.js';
import { resolveBrowserDisplay, probeHasBinary, pickFreeDisplay, type BrowserDisplay } from './display.js';

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
const XVFB_READY_TIMEOUT_MS = 10_000;
/** Virtual displays start well above the numbers real sessions use (:0 console, :10+ xrdp). */
const FIRST_VIRTUAL_DISPLAY = 99;
const XVFB_ATTEMPTS = 3;
const STOPPED_WHILE_STARTING = 'browser stopped while starting';
/** More crashes than this in the window means Chrome cannot run here at all — stop flapping. */
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS_PER_WINDOW = 3;

export interface ManagedBrowser {
  /** What agent-browser attaches to with `--cdp`. */
  cdpEndpoint: string;
  port: number;
  display: BrowserDisplay;
  pid: number;
}

interface Instance extends ManagedBrowser {
  proc: ChildProcess;
  xvfb?: ChildProcess;
}

/** A launch in flight. stopBrowser() cancels it and kills what it has spawned so far: the launch
 *  may be parked in an await when the daemon exits, and would otherwise publish an unowned Chrome. */
interface LaunchAttempt {
  cancelled: boolean;
  procs: ChildProcess[];
}

let instance: Instance | null = null;
let starting: Promise<ManagedBrowser> | null = null;
let launching: LaunchAttempt | null = null;
let refs = 0;
let idleTimer: NodeJS.Timeout | null = null;
let restartTimes: number[] = [];

/** The device name meaning "this host". Kept next to the local browser rather than in the remote
 *  domain, because it is precisely the value that means "no device is involved". */
export const BROWSER_DEVICE_SERVER = 'server';

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
    // A failed acquire must not pin a browser that never existed. stopBrowser() may already have
    // zeroed the count, and going negative would make the next release skip the idle reclaim.
    if (refs > 0) refs--;
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
  if (launching) {
    launching.cancelled = true;
    killAll(launching.procs, 'SIGTERM');
  }
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
  killAll([inst.proc, ...(inst.xvfb ? [inst.xvfb] : [])], 'SIGTERM');
}

function killAll(procs: ChildProcess[], signal: NodeJS.Signals): void {
  for (const p of procs) {
    try {
      p.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

async function ensureStarted(): Promise<ManagedBrowser> {
  if (instance) return instance;
  if (starting) return starting; // concurrent acquires must not race two Chromes onto one profile
  starting = launch().finally(() => {
    starting = null;
  });
  return starting;
}

async function launch(): Promise<ManagedBrowser> {
  const attempt: LaunchAttempt = { cancelled: false, procs: [] };
  launching = attempt;
  try {
    return await launchInto(attempt);
  } catch (e) {
    killAll(attempt.procs, 'SIGKILL'); // every failure after a spawn, including a cancel
    throw e;
  } finally {
    if (launching === attempt) launching = null;
  }
}

async function launchInto(attempt: LaunchAttempt): Promise<ManagedBrowser> {
  const checkpoint = () => {
    if (attempt.cancelled) throw new Error(STOPPED_WHILE_STARTING);
  };
  const exe = await resolveChromeBinary();
  if (!exe) {
    throw new Error(
      'no Chrome/Chromium found — install Google Chrome, or set CORTEX_BROWSER_BINARY to its path',
    );
  }
  const display = await resolveBrowserDisplay();
  checkpoint();
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const port = await pickPort(PREFERRED_CDP_PORT);
  checkpoint();

  let xvfb: ChildProcess | undefined;
  let displayName = display.display;
  if (display.mode === 'virtual') {
    const started = await startXvfb(attempt);
    xvfb = started.proc;
    displayName = started.display;
  }

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
  // Without this, Linux Chrome asks the desktop keyring for its cookie key over D-Bus, and the first
  // page load stalls ~25s until that times out — after which Chrome falls back to this store anyway.
  if (process.platform === 'linux') args.push('--password-store=basic');

  const env = { ...process.env };
  if (displayName) env.DISPLAY = displayName;
  else delete env.DISPLAY;

  log.info(`launching ${exe} on port ${port} (${display.mode}${displayName ? ` ${displayName}` : ''})`);
  const proc = spawn(exe, args, { env, stdio: 'ignore', detached: false });
  attempt.procs.push(proc);
  let spawnError: string | null = null;
  proc.on('exit', (code, signal) => onExit(proc, code, signal));
  proc.on('error', (e) => {
    spawnError = e.message;
    log.error(`Chrome failed to spawn: ${e.message}`);
  });

  await waitForCdp(port, () => {
    if (attempt.cancelled) return STOPPED_WHILE_STARTING;
    if (spawnError) return `Chrome failed to spawn: ${spawnError}`;
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return `Chrome exited during startup (code=${proc.exitCode} signal=${proc.signalCode})`;
    }
    return null;
  });
  checkpoint();

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

/** Start a virtual display and wait until it accepts connections — Chrome launched against a
 *  display that is not up yet dies at startup. Only reached when Xvfb exists (the decision function
 *  checked). The spawned process joins `attempt.procs`, so every later failure takes it down. */
async function startXvfb(attempt: LaunchAttempt): Promise<{ proc: ChildProcess; display: string }> {
  let from = FIRST_VIRTUAL_DISPLAY;
  let lastError = 'no free display number';
  for (let i = 0; i < XVFB_ATTEMPTS; i++) {
    const n = pickFreeDisplay(from);
    if (n === null) break;
    const display = `:${n}`;
    // -displayfd: Xvfb writes the display number to fd 3 once it is ready for clients.
    const proc = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp', '-displayfd', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
    });
    attempt.procs.push(proc);
    const failure = await waitForXvfb(proc);
    if (attempt.cancelled) throw new Error(STOPPED_WHILE_STARTING);
    if (!failure) return { proc, display };
    // Lost a race for this number, most likely — another server claimed it after the check.
    lastError = `${display}: ${failure}`;
    log.warn(`Xvfb ${lastError}`);
    killAll([proc], 'SIGKILL');
    from = n + 1;
  }
  throw new Error(`Xvfb could not start a virtual display (${lastError})`);
}

/** Resolves null once Xvfb reports ready, or why it never did. */
function waitForXvfb(proc: ChildProcess): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let out = '';
    const finish = (failure: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure);
    };
    const timer = setTimeout(() => finish(`not ready within ${XVFB_READY_TIMEOUT_MS}ms`), XVFB_READY_TIMEOUT_MS);
    // Wait for the whole line: closing our end early would fail Xvfb's write and abort it.
    const ready = proc.stdio[3] as Readable | null;
    ready?.on('data', (chunk) => {
      out += String(chunk);
      if (out.includes('\n')) finish(null);
    });
    ready?.on('error', () => {});
    proc.once('exit', (code, signal) => finish(`exited (code=${code} signal=${signal})`));
    proc.once('error', (e) => finish(e.message));
  });
}

export async function resolveChromeBinary(env = process.env): Promise<string | null> {
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
    if (await probeHasBinary(bin)) return bin;
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

/** Chrome writes the port file asynchronously; poll the endpoint instead of guessing a delay.
 *  `abandon` reports a reason to stop early (Chrome died, or the launch was cancelled), so neither
 *  waits out the full timeout. */
async function waitForCdp(port: number, abandon: () => string | null): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError = '';
  while (Date.now() < deadline) {
    const reason = abandon();
    if (reason) throw new Error(reason);
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
