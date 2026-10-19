import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserBroker, describeDeviceFailure, BrowserLeaseError, type BrokerDeps, type BrowserBroker,
} from '../../../src/domain/browser/broker.js';
import type { AgentBrowserRun } from '../../../src/platform/browser/agent-browser.js';

const IDLE = 60_000;

interface World {
  refs: Map<string, number>;
  endpoints: Map<string, string>;
  online: Set<string>;
  known: Set<string>;
  acquireFail: Map<string, string>;
  refreshEndpoint: Map<string, string>;
  runs: string[][];
  respond: (args: string[]) => AgentBrowserRun;
  gate: Promise<void> | null;
}

function ok(stdout = ''): AgentBrowserRun {
  return { code: 0, stdout, stderr: '' };
}

function makeWorld(): World {
  return {
    refs: new Map(), endpoints: new Map([['server', 'http://127.0.0.1:9222']]), online: new Set(['desk']),
    known: new Set(['desk', 'laptop']), acquireFail: new Map(), refreshEndpoint: new Map(), runs: [],
    respond: () => ok(), gate: null,
  };
}

function makeDeps(w: World): BrokerDeps {
  return {
    async acquire(device) {
      if (w.gate) await w.gate;
      const failure = w.acquireFail.get(device);
      if (failure) throw new Error(failure);
      w.refs.set(device, (w.refs.get(device) ?? 0) + 1);
      return w.endpoints.get(device) ?? `http://127.0.0.1:${40000 + w.refs.size}`;
    },
    release(device) {
      w.refs.set(device, (w.refs.get(device) ?? 0) - 1);
    },
    async refresh(device, endpoint) {
      return w.refreshEndpoint.get(device) ?? endpoint;
    },
    availability(device) {
      const online = [...w.online].sort();
      if (w.online.has(device)) return { state: 'online', online };
      return { state: w.known.has(device) ? 'offline' : 'unknown', online };
    },
    resolveBin: () => '/bin/agent-browser',
    baseEnv: () => ({ PATH: '/usr/bin', AGENT_BROWSER_SOCKET_DIR: '/run/ab' }),
    async run(_bin, args) {
      w.runs.push(args);
      return w.respond(args);
    },
    now: () => Date.now(),
    idleMs: IDLE,
  };
}

let w: World;
let broker: BrowserBroker;

beforeEach(() => {
  vi.useFakeTimers();
  w = makeWorld();
  broker = createBrowserBroker(makeDeps(w));
});

afterEach(() => {
  broker.shutdown();
  vi.useRealTimers();
});

/** The agent-browser command a run carried, without the attach flags every call has. */
function command(args: string[]): string[] {
  return args.slice(5);
}

describe('leaseBrowser', () => {
  it('starts the server Chrome once and reuses it across calls from one session', async () => {
    const a = await broker.leaseBrowser({ sessionId: 'sess-1' });
    const b = await broker.leaseBrowser({ sessionId: 'sess-1' });
    expect(a).toEqual({ device: 'server', cdpEndpoint: 'http://127.0.0.1:9222', abSession: 'cortex-sess-1-server' });
    expect(b).toEqual(a);
    expect(w.refs.get('server')).toBe(1);
  });

  it('gives each session its own agent-browser session on a shared Chrome', async () => {
    const a = await broker.leaseBrowser({ sessionId: 'aaa' });
    const b = await broker.leaseBrowser({ sessionId: 'bbb' });
    expect(a.cdpEndpoint).toBe(b.cdpEndpoint);
    expect(a.abSession).not.toBe(b.abSession);
    expect(w.refs.get('server')).toBe(2);
  });

  it('remembers the device a session last used', async () => {
    await broker.leaseBrowser({ sessionId: 's', device: 'desk' });
    const again = await broker.leaseBrowser({ sessionId: 's' });
    expect(again.device).toBe('desk');
    expect(again.abSession).toBe('cortex-s-desk');
  });

  it('switching device releases the old Chrome, closes its tab and its agent-browser daemon', async () => {
    await broker.leaseBrowser({ sessionId: 's' });
    await broker.leaseBrowser({ sessionId: 's', device: 'desk' });
    expect(w.refs.get('server')).toBe(0);
    expect(w.refs.get('desk')).toBe(1);
    expect(w.runs.map(command)).toEqual([['tab', 'close'], ['close']]);
    expect(w.runs[0]).toContain('cortex-s-server');
    expect(w.runs[0]).toContain('--cdp');
  });

  it('shows the lease as starting while Chrome launches, then ready', async () => {
    let open!: () => void;
    w.gate = new Promise((r) => { open = r; });
    const changes: string[] = [];
    broker.onBrowserSessionsChanged(() => changes.push(broker.listBrowserSessions()[0]?.state ?? 'gone'));
    const pending = broker.leaseBrowser({ sessionId: 's' });
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.listBrowserSessions()).toMatchObject([{ sessionId: 's', state: 'starting', device: 'server' }]);
    open();
    await pending;
    expect(broker.listBrowserSessions()[0].state).toBe('ready');
    expect(changes).toEqual(['starting', 'ready']);
  });

  it('serializes concurrent first calls into one Chrome reference', async () => {
    await Promise.all([broker.leaseBrowser({ sessionId: 's' }), broker.leaseBrowser({ sessionId: 's' })]);
    expect(w.refs.get('server')).toBe(1);
  });

  it('refuses an offline device and an unknown one, naming the alternatives', async () => {
    const offline = await broker.leaseBrowser({ sessionId: 's', device: 'laptop' }).catch((e) => e);
    expect(offline).toBeInstanceOf(BrowserLeaseError);
    expect(offline.code).toBe('device-offline');
    expect(offline.message).toBe('device "laptop" is offline');
    expect(offline.hint).toContain('server, desk');

    const unknown = await broker.leaseBrowser({ sessionId: 't', device: 'nope' }).catch((e) => e);
    expect(unknown.code).toBe('unknown-device');
    expect(unknown.hint).toBe('use one of: server, desk');
    expect(w.refs.get('laptop')).toBeUndefined();
  });

  it('reports a Chrome launch failure with its real reason and keeps it visible', async () => {
    w.acquireFail.set('desk', 'chrome-not-found');
    const err = await broker.leaseBrowser({ sessionId: 's', device: 'desk' }).catch((e) => e);
    expect(err.code).toBe('chrome-failed');
    expect(err.message).toBe('Chrome is not installed on desk');
    expect(broker.listBrowserSessions()).toMatchObject([{ state: 'error', error: expect.stringContaining('not installed') }]);
    // The next call retries instead of replaying the failure.
    w.acquireFail.clear();
    await expect(broker.leaseBrowser({ sessionId: 's' })).resolves.toMatchObject({ device: 'desk' });
    expect(broker.listBrowserSessions()[0].state).toBe('ready');
  });

  it('follows a Chrome that moved to another endpoint', async () => {
    await broker.leaseBrowser({ sessionId: 's' });
    w.refreshEndpoint.set('server', 'http://127.0.0.1:9223');
    const again = await broker.leaseBrowser({ sessionId: 's' });
    expect(again.cdpEndpoint).toBe('http://127.0.0.1:9223');
    expect(w.refs.get('server')).toBe(1);
  });

  it('requires a session id', async () => {
    const err = await broker.leaseBrowser({ sessionId: '' }).catch((e) => e);
    expect(err.code).toBe('bad-request');
  });
});

describe('idle release', () => {
  it('releases the Chrome reference after the idle window, renewed by every call', async () => {
    await broker.leaseBrowser({ sessionId: 's' });
    await vi.advanceTimersByTimeAsync(IDLE - 1000);
    await broker.leaseBrowser({ sessionId: 's' });
    await vi.advanceTimersByTimeAsync(IDLE - 1000);
    expect(w.refs.get('server')).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(w.refs.get('server')).toBe(0);
    expect(broker.listBrowserSessions()).toEqual([]);
    expect(w.runs.map(command)).toEqual([['tab', 'close'], ['close']]);
  });

  it('releases the Chrome reference before closing the tab', async () => {
    const order: string[] = [];
    const deps = makeDeps(w);
    const b = createBrowserBroker({
      ...deps,
      release: (d) => { order.push('release'); deps.release(d); },
      run: async (bin, args, env) => { order.push(command(args).join(' ')); return deps.run(bin, args, env); },
    });
    await b.leaseBrowser({ sessionId: 's' });
    await vi.advanceTimersByTimeAsync(IDLE + 1);
    expect(order).toEqual(['release', 'tab close', 'close']);
    b.shutdown();
  });

  it('keeps the browser while the user has taken over', async () => {
    await broker.leaseBrowser({ sessionId: 's' });
    broker.setTakeover('s', true);
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(w.refs.get('server')).toBe(1);
    broker.setTakeover('s', false);
    await vi.advanceTimersByTimeAsync(IDLE + 1);
    expect(w.refs.get('server')).toBe(0);
  });
});

describe('takeover', () => {
  it('refuses agent leases while the user is in control, but not the daemon\'s own calls', async () => {
    await broker.leaseBrowser({ sessionId: 's' });
    broker.setTakeover('s', true);
    expect(broker.isTakenOver('s')).toBe(true);
    const err = await broker.leaseBrowser({ sessionId: 's' }).catch((e) => e);
    expect(err.code).toBe('taken-over');
    expect(err.message).toContain('user is controlling');
    await broker.insertText('s', '你好');
    expect(command(w.runs.at(-1)!)).toEqual(['keyboard', 'inserttext', '你好']);
    broker.setTakeover('s', false);
    await expect(broker.leaseBrowser({ sessionId: 's' })).resolves.toBeTruthy();
  });

  it('needs a lease to take over', () => {
    expect(() => broker.setTakeover('ghost', true)).toThrow(/has no browser/);
  });
});

describe('runAgentBrowser', () => {
  it('always attaches with --cdp, --session and --pin-tab', async () => {
    await broker.runAgentBrowser('s', ['snapshot', '-i']);
    expect(w.runs[0]).toEqual(['--cdp', 'http://127.0.0.1:9222', '--session', 'cortex-s-server', '--pin-tab', 'snapshot', '-i']);
  });

  it('rebinds a fresh tab once when the bound tab is gone, then retries', async () => {
    let gone = true;
    w.respond = (args) => {
      const cmd = command(args);
      if (cmd[0] === 'tab' && cmd[1] === 'new') { gone = false; return ok(); }
      if (gone) return { code: 1, stdout: '', stderr: '✗ tab_gone: bound tab is gone (target X)' };
      return ok('done');
    };
    const result = await broker.runAgentBrowser('s', ['get', 'title']);
    expect(result).toEqual(ok('done'));
    expect(w.runs.slice(0, 3).map(command)).toEqual([['get', 'title'], ['tab', 'new'], ['get', 'title']]);
  });

  it('returns other failures as they are', async () => {
    w.respond = () => ({ code: 1, stdout: '', stderr: '✗ Navigation failed: net::ERR_CONNECTION_REFUSED' });
    const result = await broker.runAgentBrowser('s', ['open', 'http://127.0.0.1:1']);
    expect(result.code).toBe(1);
    expect(w.runs.filter((r) => command(r)[0] === 'tab')).toEqual([]);
  });
});

describe('page info and stream', () => {
  it('refreshes url and title after a reported command', async () => {
    w.respond = (args) => {
      const cmd = command(args);
      if (cmd.join(' ') === '--json get url') return ok(JSON.stringify({ success: true, data: { url: 'http://x/' } }));
      if (cmd.join(' ') === '--json get title') return ok(JSON.stringify({ success: true, data: { title: 'X' } }));
      return ok();
    };
    await broker.leaseBrowser({ sessionId: 's' });
    broker.noteBrowserCommand('s');
    await vi.advanceTimersByTimeAsync(0);
    expect(broker.listBrowserSessions()[0]).toMatchObject({ url: 'http://x/', title: 'X' });
  });

  it('reads the stream port, enabling streaming when it is off', async () => {
    w.respond = (args) => {
      const cmd = command(args).join(' ');
      if (cmd === '--json stream status') return ok(JSON.stringify({ data: { enabled: false, port: null } }));
      if (cmd === '--json stream enable') return ok(JSON.stringify({ data: { port: 37001 } }));
      return ok();
    };
    expect(await broker.streamPort('s')).toBeNull();
    await broker.leaseBrowser({ sessionId: 's' });
    expect(await broker.streamPort('s')).toBe(37001);
  });
});

describe('describeDeviceFailure', () => {
  it('turns launch-script markers into sentences with a next step', () => {
    expect(describeDeviceFailure('pc', 'no-interactive-user').message).toBe('nobody is logged in to the desktop on pc');
    expect(describeDeviceFailure('pc', 'Command to "pc" timed out after 90s').hint).toContain('awake');
    expect(describeDeviceFailure('pc', 'weird').message).toBe('could not start Chrome on pc: weird');
  });
});
