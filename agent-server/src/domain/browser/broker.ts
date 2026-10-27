import { createLogger } from '@core/log.js';
import {
  acquireBrowser, releaseBrowser, browserStatus, BROWSER_DEVICE_SERVER,
} from '@platform/browser/managed-browser.js';
import {
  agentBrowserArgs, agentBrowserBaseEnv, agentBrowserSessionName, isTabGone, resolveAgentBrowserBin,
  runAgentBrowserProcess, AgentBrowserMissingError, SESSION_VIEWPORT_ARGS, type AgentBrowserRun,
} from '@platform/browser/agent-browser.js';
import { acquireDeviceBrowser, releaseDeviceBrowser } from '../remote/device-browser.js';
import { getOnlineDevices, isDeviceOnline } from '../remote/client-manager.js';
import { getMachineRegistry } from '../remote/machine-registry.js';

const log = createLogger('browser-broker');

/**
 * Browser leases for `cortex-browser`, held per Cortex session rather than per turn.
 *
 * A lease ties one session to one device's shared Chrome (server-local, or a device's through the
 * reverse channel) and to one agent-browser session pinned to its own tab there. It holds one
 * reference on that Chrome, is renewed by every call, and is released, closing its tab, after
 * {@link LEASE_IDLE_MS} without one. Page state survives between turns because nothing here is torn
 * down per turn.
 */

export const LEASE_IDLE_MS = 10 * 60_000;
/** How long a device endpoint is trusted before a call re-checks it through the tunnel. */
const DEVICE_VERIFY_MS = 15_000;
const VERIFY_TIMEOUT_MS = 5_000;

export type BrowserSessionState = 'starting' | 'ready' | 'error';

export interface BrowserSessionInfo {
  sessionId: string;
  device: string;
  abSession: string;
  state: BrowserSessionState;
  error?: string;
  url?: string;
  title?: string;
  takenOver: boolean;
  lastUsedAt: number;
}

export interface BrowserLease {
  device: string;
  cdpEndpoint: string;
  abSession: string;
}

export type BrowserLeaseErrorCode =
  | 'bad-request' | 'unknown-device' | 'device-offline' | 'taken-over' | 'chrome-failed' | 'engine-missing'
  | 'no-lease';

/** A lease failure meant for a human: what went wrong, and what to do about it. */
export class BrowserLeaseError extends Error {
  readonly code: BrowserLeaseErrorCode;
  readonly hint?: string;
  constructor(code: BrowserLeaseErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'BrowserLeaseError';
    this.code = code;
    this.hint = hint;
  }
}

/** Device states the broker distinguishes when asked for one. */
export type DeviceAvailability = 'online' | 'offline' | 'unknown';

export interface BrokerDeps {
  /** Take one reference on the device's Chrome, starting it if needed. */
  acquire(device: string): Promise<string>;
  /** Drop one reference taken by {@link acquire}. */
  release(device: string): void;
  /**
   * The device's live endpoint for a lease that already holds a reference, relaunching Chrome if
   * it died. Must leave the reference count as it found it.
   */
  refresh(device: string, cdpEndpoint: string): Promise<string>;
  availability(device: string): { state: DeviceAvailability; online: string[] };
  resolveBin(): string;
  baseEnv(): Record<string, string>;
  run(bin: string, args: string[], env: Record<string, string>): Promise<AgentBrowserRun>;
  now(): number;
  idleMs: number;
}

interface Lease {
  sessionId: string;
  device: string;
  abSession: string;
  state: BrowserSessionState;
  error?: string;
  cdpEndpoint: string | null;
  /** Whether this lease holds a reference on the device's Chrome. */
  holdsRef: boolean;
  url?: string;
  title?: string;
  takenOver: boolean;
  lastUsedAt: number;
  idleTimer: NodeJS.Timeout | null;
  refreshing: boolean;
  refreshAgain: boolean;
}

export interface BrowserBroker {
  leaseBrowser(input: { sessionId: string; device?: string | null }): Promise<BrowserLease>;
  listBrowserSessions(): BrowserSessionInfo[];
  runAgentBrowser(sessionId: string, args: string[]): Promise<AgentBrowserRun>;
  streamPort(sessionId: string): Promise<number | null>;
  setTakeover(sessionId: string, on: boolean): void;
  isTakenOver(sessionId: string): boolean;
  insertText(sessionId: string, text: string): Promise<void>;
  /** A CLI call finished: refresh the URL and title shown for the session. */
  noteBrowserCommand(sessionId: string): void;
  /** The binary and environment a CLI call must use to reach this broker's daemons. */
  agentBrowserRuntime(): { bin: string; env: Record<string, string> };
  onBrowserSessionsChanged(listener: () => void): () => void;
  /** Forget every lease (daemon shutdown). Chrome itself is stopped by its own owner. */
  shutdown(): void;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Turn a device launch failure (often a bare marker from the launch script) into a sentence. */
export function describeDeviceFailure(device: string, raw: string): { message: string; hint?: string } {
  const text = raw.trim();
  const other = `or run without --device to use the server's browser`;
  if (text.includes('chrome-not-found')) {
    return { message: `Chrome is not installed on ${device}`, hint: `install Google Chrome on ${device}, ${other}` };
  }
  if (text.includes('no-interactive-user')) {
    return { message: `nobody is logged in to the desktop on ${device}`, hint: `log in on ${device}, ${other}` };
  }
  if (text.includes('interactive-user-mismatch')) {
    return {
      message: `the Cortex client on ${device} runs as a different user than the desktop session`,
      hint: `run the Cortex client as the logged-in user on ${device}`,
    };
  }
  if (text.includes('chrome-did-not-listen')) {
    return {
      message: `Chrome on ${device} did not open its debugging port in time`,
      hint: `close any Chrome window still using the Cortex profile on ${device} and retry`,
    };
  }
  if (/timed out/i.test(text)) {
    return { message: `${device} did not answer while starting Chrome (${text})`, hint: `check that ${device} is awake and its Cortex client is connected` };
  }
  return { message: `could not start Chrome on ${device}: ${text || 'unknown error'}` };
}

export function createBrowserBroker(deps: BrokerDeps): BrowserBroker {
  const leases = new Map<string, Lease>();
  const sessionChains = new Map<string, Promise<unknown>>();
  const deviceChains = new Map<string, Promise<unknown>>();
  const lastVerified = new Map<Lease, number>();
  const listeners = new Set<() => void>();
  let runtime: { bin: string; env: Record<string, string> } | null = null;

  function notify(): void {
    for (const fn of listeners) {
      try { fn(); } catch (e) { log.warn(`listener failed: ${(e as Error).message}`); }
    }
  }

  /** Run `fn` after every earlier call queued under `key` has settled. */
  function serial<T>(chains: Map<string, Promise<unknown>>, key: string, fn: () => Promise<T>): Promise<T> {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    const tail = next.catch(() => undefined);
    chains.set(key, tail);
    void tail.then(() => { if (chains.get(key) === tail) chains.delete(key); });
    return next;
  }

  function getRuntime(): { bin: string; env: Record<string, string> } {
    if (runtime) return runtime;
    try {
      runtime = { bin: deps.resolveBin(), env: deps.baseEnv() };
    } catch (e) {
      if (e instanceof AgentBrowserMissingError) throw new BrowserLeaseError('engine-missing', e.message, e.hint);
      throw e;
    }
    return runtime;
  }

  function arm(lease: Lease): void {
    if (lease.idleTimer) clearTimeout(lease.idleTimer);
    lease.idleTimer = setTimeout(() => {
      lease.idleTimer = null;
      // A human mid-login can take a while; their session keeps the browser.
      if (lease.takenOver) { arm(lease); return; }
      if (leases.get(lease.sessionId) !== lease) return;
      log.info(`${lease.sessionId}: browser idle for ${Math.round(deps.idleMs / 60_000)} min — releasing`);
      void serial(sessionChains, lease.sessionId, async () => {
        if (leases.get(lease.sessionId) === lease && !lease.takenOver) await retire(lease);
      });
    }, deps.idleMs);
    lease.idleTimer.unref?.();
  }

  function touch(lease: Lease): void {
    lease.lastUsedAt = deps.now();
    arm(lease);
  }

  /**
   * End a lease: drop its Chrome reference, close the session's tab and stop its agent-browser
   * daemon. Closing the tab makes an idle release look the same as Chrome being reclaimed, and
   * keeps a Chrome that other sessions hold open from collecting abandoned tabs. Logins live in
   * the profile, not the tab. The next call in the session finds its tab gone and opens a new one.
   *
   * The reference goes first: if this was the last tab, Chrome exits, and with no reference left
   * it is not restarted.
   */
  async function retire(lease: Lease): Promise<void> {
    if (lease.idleTimer) clearTimeout(lease.idleTimer);
    lease.idleTimer = null;
    if (leases.get(lease.sessionId) === lease) leases.delete(lease.sessionId);
    lastVerified.delete(lease);
    if (lease.holdsRef) {
      lease.holdsRef = false;
      deps.release(lease.device);
    }
    notify();
    if (!lease.cdpEndpoint || !runtime) return;
    // With --cdp even here: a call without it makes agent-browser launch a Chrome of its own.
    for (const command of [['tab', 'close'], ['close']]) {
      await deps.run(runtime.bin, agentBrowserArgs(lease.cdpEndpoint, lease.abSession, command), runtime.env)
        .catch(() => undefined);
    }
  }

  /** Record a failure on the lease and keep it listed, without a Chrome reference, until the next
   *  call retries or the idle timer drops it — so the UI can show why the browser is not there. */
  function fail(lease: Lease, err: BrowserLeaseError): BrowserLeaseError {
    if (lease.holdsRef) {
      lease.holdsRef = false;
      deps.release(lease.device);
    }
    lastVerified.delete(lease);
    lease.state = 'error';
    lease.error = err.hint ? `${err.message} — ${err.hint}` : err.message;
    lease.cdpEndpoint = null;
    notify();
    return err;
  }

  function checkDevice(device: string): void {
    if (device === BROWSER_DEVICE_SERVER) return;
    const { state, online } = deps.availability(device);
    if (state === 'online') return;
    const known = online.length ? `online devices: ${['server', ...online].join(', ')}` : 'no devices are online';
    if (state === 'offline') {
      throw new BrowserLeaseError('device-offline', `device "${device}" is offline`,
        `start its Cortex client, or pick another device (${known})`);
    }
    throw new BrowserLeaseError('unknown-device', `unknown device "${device}"`, `use one of: server${online.length ? `, ${online.join(', ')}` : ''}`);
  }

  function chromeError(device: string, e: unknown): BrowserLeaseError {
    if (e instanceof BrowserLeaseError) return e;
    const raw = (e as Error)?.message ?? String(e);
    if (device === BROWSER_DEVICE_SERVER) {
      return new BrowserLeaseError('chrome-failed', `could not start Chrome on the server: ${raw}`);
    }
    const { message, hint } = describeDeviceFailure(device, raw);
    return new BrowserLeaseError('chrome-failed', message, hint);
  }

  function acquireOn(device: string): Promise<string> {
    // Device launches are serialized: two concurrent first acquires would each launch and map.
    return device === BROWSER_DEVICE_SERVER
      ? deps.acquire(device)
      : serial(deviceChains, device, () => deps.acquire(device));
  }

  async function start(lease: Lease): Promise<void> {
    try {
      checkDevice(lease.device);
      getRuntime();
      lease.cdpEndpoint = await acquireOn(lease.device);
      lease.holdsRef = true;
      await pinViewport(lease);
      lease.state = 'ready';
      lease.error = undefined;
      lastVerified.set(lease, deps.now());
      log.info(`${lease.sessionId}: browser ready on ${lease.device} (${lease.abSession})`);
    } catch (e) {
      throw fail(lease, chromeError(lease.device, e));
    }
    notify();
  }

  /** Make sure an existing ready lease still points at a live Chrome. */
  async function revalidate(lease: Lease): Promise<void> {
    const due = lease.device === BROWSER_DEVICE_SERVER
      || deps.now() - (lastVerified.get(lease) ?? 0) >= DEVICE_VERIFY_MS;
    if (!due || !lease.cdpEndpoint) return;
    try {
      checkDevice(lease.device);
      const endpoint = await (lease.device === BROWSER_DEVICE_SERVER
        ? deps.refresh(lease.device, lease.cdpEndpoint)
        : serial(deviceChains, lease.device, () => deps.refresh(lease.device, lease.cdpEndpoint!)));
      lastVerified.set(lease, deps.now());
      if (endpoint !== lease.cdpEndpoint) {
        log.info(`${lease.sessionId}: ${lease.device} browser moved to ${endpoint}`);
        lease.cdpEndpoint = endpoint;
        notify();
      }
    } catch (e) {
      throw fail(lease, chromeError(lease.device, e));
    }
  }

  /** The session's lease on `device` (or its current device), created or renewed. */
  function ensure(sessionId: string, device: string | null, refuseTakenOver: boolean): Promise<Lease> {
    return serial(sessionChains, sessionId, async () => {
      let lease = leases.get(sessionId);
      if (refuseTakenOver && lease?.takenOver) {
        throw new BrowserLeaseError('taken-over', 'the user is controlling this browser right now',
          'wait for them to hand it back, or ask them; do not retry in a loop');
      }
      const target = device || lease?.device || BROWSER_DEVICE_SERVER;
      if (lease && (lease.device !== target || lease.state === 'error')) {
        const takenOver = lease.takenOver;
        await retire(lease);
        lease = undefined;
        if (takenOver) log.info(`${sessionId}: switching device ends the takeover`);
      }
      if (lease?.state === 'ready') {
        await revalidate(lease);
        touch(lease);
        return lease;
      }
      const fresh: Lease = {
        sessionId, device: target, abSession: agentBrowserSessionName(sessionId, target),
        state: 'starting', cdpEndpoint: null, holdsRef: false, takenOver: false,
        lastUsedAt: deps.now(), idleTimer: null, refreshing: false, refreshAgain: false,
      };
      leases.set(sessionId, fresh);
      touch(fresh);
      notify();
      await start(fresh);
      return fresh;
    });
  }

  function existing(sessionId: string): Lease {
    const lease = leases.get(sessionId);
    if (!lease) throw new BrowserLeaseError('no-lease', `session ${sessionId} has no browser`);
    return lease;
  }

  function ready(sessionId: string): Lease {
    const lease = existing(sessionId);
    if (lease.state !== 'ready' || !lease.cdpEndpoint) {
      throw new BrowserLeaseError('no-lease', `the browser for session ${sessionId} is ${lease.state}`);
    }
    return lease;
  }

  async function exec(lease: Lease, args: string[]): Promise<AgentBrowserRun> {
    const rt = getRuntime();
    const run = () => deps.run(rt.bin, agentBrowserArgs(lease.cdpEndpoint!, lease.abSession, args), rt.env);
    const first = await run();
    if (first.code === 0 || !isTabGone(first.stderr)) return first;
    // The Chrome behind the binding was replaced or the tab closed: bind a fresh tab, once.
    log.info(`${lease.sessionId}: bound tab is gone — opening a new one`);
    const rebound = await deps.run(rt.bin, agentBrowserArgs(lease.cdpEndpoint!, lease.abSession, ['tab', 'new']), rt.env);
    if (rebound.code !== 0) return first;
    await pinViewport(lease);
    return run();
  }

  /** Bind the session's tab and give it the standard viewport. Best effort: a page at the window's
   *  size still works, it only streams oddly. */
  async function pinViewport(lease: Lease): Promise<void> {
    const rt = getRuntime();
    const result = await deps.run(rt.bin, agentBrowserArgs(lease.cdpEndpoint!, lease.abSession, SESSION_VIEWPORT_ARGS), rt.env)
      .catch((e: unknown) => ({ code: -1, stdout: '', stderr: String(e) }));
    if (result.code !== 0) log.warn(`${lease.sessionId}: could not set the viewport: ${result.stderr.trim().slice(0, 200)}`);
  }

  async function refreshInfo(lease: Lease): Promise<void> {
    if (lease.refreshing) { lease.refreshAgain = true; return; }
    lease.refreshing = true;
    try {
      do {
        lease.refreshAgain = false;
        if (leases.get(lease.sessionId) !== lease || lease.state !== 'ready' || !runtime) return;
        const read = async (what: 'url' | 'title') => {
          const r = await deps.run(runtime!.bin, agentBrowserArgs(lease.cdpEndpoint!, lease.abSession, ['--json', 'get', what]), runtime!.env);
          if (r.code !== 0) return undefined;
          try { return str(JSON.parse(r.stdout)?.data?.[what]) || undefined; } catch { return undefined; }
        };
        const [url, title] = [await read('url'), await read('title')];
        if (url !== lease.url || title !== lease.title) {
          lease.url = url;
          lease.title = title;
          notify();
        }
      } while (lease.refreshAgain);
    } finally {
      lease.refreshing = false;
    }
  }

  function parseJson(stdout: string): any {
    try { return JSON.parse(stdout); } catch { return null; }
  }

  return {
    async leaseBrowser({ sessionId, device }) {
      const sid = str(sessionId);
      if (!sid) {
        throw new BrowserLeaseError('bad-request', 'no session id',
          'cortex-browser must run inside a Cortex session (CORTEX_SESSION_ID is unset)');
      }
      const lease = await ensure(sid, str(device) || null, true);
      return { device: lease.device, cdpEndpoint: lease.cdpEndpoint!, abSession: lease.abSession };
    },

    listBrowserSessions() {
      return [...leases.values()]
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
        .map((l) => ({
          sessionId: l.sessionId, device: l.device, abSession: l.abSession, state: l.state,
          ...(l.error ? { error: l.error } : {}),
          ...(l.url ? { url: l.url } : {}),
          ...(l.title ? { title: l.title } : {}),
          takenOver: l.takenOver, lastUsedAt: l.lastUsedAt,
        }));
    },

    async runAgentBrowser(sessionId, args) {
      const lease = await ensure(sessionId, null, false);
      const result = await exec(lease, args);
      void refreshInfo(lease);
      return result;
    },

    async streamPort(sessionId) {
      const lease = leases.get(sessionId);
      if (!lease || lease.state !== 'ready') return null;
      const status = parseJson((await exec(lease, ['--json', 'stream', 'status'])).stdout);
      if (status?.data?.enabled && typeof status.data.port === 'number') return status.data.port;
      const enabled = parseJson((await exec(lease, ['--json', 'stream', 'enable'])).stdout);
      return typeof enabled?.data?.port === 'number' ? enabled.data.port : null;
    },

    setTakeover(sessionId, on) {
      const lease = existing(sessionId);
      if (lease.takenOver === on) return;
      lease.takenOver = on;
      touch(lease);
      log.info(`${sessionId}: browser ${on ? 'taken over by the user' : 'handed back to the agent'}`);
      notify();
    },

    isTakenOver(sessionId) {
      return leases.get(sessionId)?.takenOver ?? false;
    },

    async insertText(sessionId, text) {
      const lease = ready(sessionId);
      const result = await exec(lease, ['keyboard', 'inserttext', text]);
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || `agent-browser exited ${result.code}`);
      }
    },

    noteBrowserCommand(sessionId) {
      const lease = leases.get(str(sessionId));
      if (!lease) return;
      touch(lease);
      void refreshInfo(lease);
    },

    agentBrowserRuntime() {
      return getRuntime();
    },

    onBrowserSessionsChanged(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },

    shutdown() {
      for (const lease of leases.values()) {
        if (lease.idleTimer) clearTimeout(lease.idleTimer);
      }
      leases.clear();
      listeners.clear();
    },
  };
}

async function endpointAlive(cdpEndpoint: string): Promise<boolean> {
  try {
    const res = await fetch(`${cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

export function defaultBrokerDeps(): BrokerDeps {
  return {
    async acquire(device) {
      return device === BROWSER_DEVICE_SERVER
        ? (await acquireBrowser()).cdpEndpoint
        : (await acquireDeviceBrowser(device)).cdpEndpoint;
    },
    release(device) {
      if (device === BROWSER_DEVICE_SERVER) releaseBrowser();
      else releaseDeviceBrowser(device);
    },
    async refresh(device, cdpEndpoint) {
      if (device === BROWSER_DEVICE_SERVER) {
        // The managed browser restarts itself after a crash while references remain; only a
        // browser that gave up needs a fresh start, and acquire+release leaves our one reference.
        const live = browserStatus().browser?.cdpEndpoint;
        if (live) return live;
        const endpoint = (await acquireBrowser()).cdpEndpoint;
        releaseBrowser();
        return endpoint;
      }
      if (await endpointAlive(cdpEndpoint)) return cdpEndpoint;
      // A dead endpoint: the next acquire drops the stale entry, our reference with it, and the
      // reference it hands back is ours.
      return (await acquireDeviceBrowser(device)).cdpEndpoint;
    },
    availability(device) {
      const online = getOnlineDevices().map((d) => d.device).sort();
      if (isDeviceOnline(device)) return { state: 'online', online };
      return { state: Object.hasOwn(getMachineRegistry(), device) ? 'offline' : 'unknown', online };
    },
    resolveBin: () => resolveAgentBrowserBin(),
    baseEnv: () => agentBrowserBaseEnv(),
    run: (bin, args, env) => runAgentBrowserProcess(bin, args, { env }),
    now: () => Date.now(),
    idleMs: LEASE_IDLE_MS,
  };
}

let broker: BrowserBroker | null = null;

function instance(): BrowserBroker {
  broker ??= createBrowserBroker(defaultBrokerDeps());
  return broker;
}

/** Test seam: swap the process-wide broker (pass null to rebuild it from the real deps). */
export function _setBrowserBroker(next: BrowserBroker | null): void {
  broker = next;
}

export const leaseBrowser: BrowserBroker['leaseBrowser'] = (input) => instance().leaseBrowser(input);
export const listBrowserSessions: BrowserBroker['listBrowserSessions'] = () => instance().listBrowserSessions();
export const runAgentBrowser: BrowserBroker['runAgentBrowser'] = (sid, args) => instance().runAgentBrowser(sid, args);
export const streamPort: BrowserBroker['streamPort'] = (sid) => instance().streamPort(sid);
export const setTakeover: BrowserBroker['setTakeover'] = (sid, on) => instance().setTakeover(sid, on);
export const isTakenOver: BrowserBroker['isTakenOver'] = (sid) => instance().isTakenOver(sid);
export const insertText: BrowserBroker['insertText'] = (sid, text) => instance().insertText(sid, text);
export const noteBrowserCommand: BrowserBroker['noteBrowserCommand'] = (sid) => instance().noteBrowserCommand(sid);
export const agentBrowserRuntime: BrowserBroker['agentBrowserRuntime'] = () => instance().agentBrowserRuntime();
export const onBrowserSessionsChanged: BrowserBroker['onBrowserSessionsChanged'] = (fn) => instance().onBrowserSessionsChanged(fn);
export function shutdownBrowserBroker(): void {
  broker?.shutdown();
}
