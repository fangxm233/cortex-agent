import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import type * as net from 'net';
import { initTRPC } from '@trpc/server';
import { WebSocket, WebSocketServer } from 'ws';
import { createAuthorizer, createUiHttpServer } from '@platform/ui-http/ui-http-server.js';
import {
  BROWSER_INSERT_TEXT_PATH,
  BROWSER_SESSIONS_PATH,
  BROWSER_STREAM_PATH,
  BROWSER_TAKEOVER_PATH,
  BROWSER_TICKET_PATH,
  CLOSE_NO_STREAM,
  CLOSE_UPSTREAM_GONE,
  TAKEOVER_MESSAGE,
  admitClientMessage,
  clampFps,
  createBrowserStream,
  createTakeoverWatch,
  createTicketStore,
  parseClientId,
  parseStreamTarget,
  type BrowserSessionView,
  type BrowserStreamDeps,
  type BrowserStreamOptions,
} from '@platform/ui-http/browser-stream.js';

const TOKEN = 'browser-stream-test-token';

describe('admitClientMessage', () => {
  it('passes acks, normalised, whoever holds the page', () => {
    expect(admitClientMessage('{"type":"ack","seq":7,"x":1}', false)).toEqual({ message: '{"type":"ack","seq":7}', input: false });
    expect(admitClientMessage('{"type":"ack","seq":"7"}', true)).toBeNull();
  });

  it('passes input only from the window holding the page, marked as input', () => {
    const click = JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 });
    expect(admitClientMessage(click, false)).toBeNull();
    expect(admitClientMessage(click, true)).toEqual({ message: click, input: true });
    const key = JSON.stringify({ type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA' });
    expect(admitClientMessage(key, true)).toEqual({ message: key, input: true });
  });

  it('reads a window id, telling absent from malformed', () => {
    expect(parseClientId(undefined)).toBe('');
    expect(parseClientId('tab_1-A')).toBe('tab_1-A');
    expect(parseClientId('no spaces')).toBeNull();
    expect(parseClientId(42)).toBeNull();
  });

  it('drops config, unknown types and garbage', () => {
    expect(admitClientMessage('{"type":"config","maxFps":120}', true)).toBeNull();
    expect(admitClientMessage('{"type":"eval"}', true)).toBeNull();
    expect(admitClientMessage('not json', true)).toBeNull();
    expect(admitClientMessage('null', true)).toBeNull();
  });
});

describe('stream target', () => {
  it('clamps the frame rate', () => {
    expect(clampFps(null)).toBe(10);
    expect(clampFps('0')).toBe(10);
    expect(clampFps('4')).toBe(4);
    expect(clampFps('600')).toBe(15);
  });

  it('needs a session and a ticket', () => {
    expect(parseStreamTarget('/api/browser/stream?session=s1&ticket=t&maxFps=5')).toEqual({ sessionId: 's1', ticket: 't', fps: 5 });
    expect(parseStreamTarget('/api/browser/stream?session=s1')).toBeNull();
    expect(parseStreamTarget('/api/browser/stream?ticket=t')).toBeNull();
  });
});

describe('ticket store', () => {
  it('spends a ticket once, for its own session only, and names its window', () => {
    const store = createTicketStore();
    const a = store.mint('s1', 'w1');
    expect(store.redeem(a, 's2')).toBeNull();
    expect(store.redeem(a, 's1')).toBeNull(); // spent by the failed attempt
    const b = store.mint('s1', 'w1');
    expect(store.redeem(b, 's1')).toEqual({ client: 'w1' });
    expect(store.redeem(b, 's1')).toBeNull();
    expect(store.redeem(store.mint('s1'), 's1')).toEqual({ client: '' });
    expect(store.redeem('', 's1')).toBeNull();
  });

  it('expires', () => {
    let t = 1_000;
    const store = createTicketStore(() => t);
    const a = store.mint('s1');
    t += 31_000;
    expect(store.redeem(a, 's1')).toBeNull();
    expect(store.size()).toBe(0);
  });
});

describe('takeover watch', () => {
  function setup() {
    vi.useFakeTimers();
    let t = 0;
    const taken = new Set<string>(['s1']);
    const clients = new Set<string>();
    const released: string[] = [];
    const watch = createTakeoverWatch({
      isTakenOver: (sid) => taken.has(sid),
      hasClient: (_sid, client) => clients.has(client),
      release: (sid, reason) => { released.push(`${sid}:${reason}`); taken.delete(sid); },
      now: () => t,
      graceMs: 30_000,
      idleMs: 600_000,
    });
    const advance = (ms: number) => { t += ms; vi.advanceTimersByTime(ms); };
    return { watch, clients, released, advance };
  }
  afterEach(() => vi.useRealTimers());

  it('hands back 30 s after the holding window goes, unless it comes back', () => {
    const { watch, clients, released, advance } = setup();
    clients.add('w1');
    watch.begin('s1', 'w1');
    clients.delete('w1');
    watch.disconnected('s1', 'w1');
    advance(20_000);
    clients.add('w1');
    watch.connected('s1', 'w1'); // a reload within the grace keeps the page
    advance(60_000);
    expect(released).toEqual([]);
    clients.delete('w1');
    watch.disconnected('s1', 'w1');
    advance(29_999);
    expect(released).toEqual([]);
    advance(1);
    expect(released).toEqual(['s1:disconnected']);
    expect(watch.holder('s1')).toBeNull();
  });

  it('starts the grace at once when the window has no stream open', () => {
    const { watch, released, advance } = setup();
    watch.begin('s1', 'w1');
    advance(30_000);
    expect(released).toEqual(['s1:disconnected']);
  });

  it('ignores another window coming and going', () => {
    const { watch, clients, released, advance } = setup();
    clients.add('w1');
    watch.begin('s1', 'w1');
    watch.disconnected('s1', 'w2');
    advance(60_000);
    expect(released).toEqual([]);
  });

  it('hands back after 10 minutes without input, counting from the last one', () => {
    const { watch, clients, released, advance } = setup();
    clients.add('w1');
    watch.begin('s1', 'w1');
    advance(500_000);
    watch.input('s1');
    advance(500_000);
    expect(released).toEqual([]);
    advance(100_000);
    expect(released).toEqual(['s1:idle']);
  });

  it('does nothing once handed back by hand, or when the broker already dropped it', () => {
    const { watch, released, advance } = setup();
    watch.begin('s1', 'w1');
    watch.end('s1');
    advance(700_000);
    expect(released).toEqual([]);
    watch.begin('s2', 'w1'); // s2 is not taken over in the broker
    advance(700_000);
    expect(released).toEqual([]);
  });
});

// ── End to end: ui-http server → proxy → a fake agent-browser stream ─────────

const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of cleanups.reverse()) await c();
});

interface FakeUpstream {
  port: number;
  received: string[];
  urls: string[];
  sockets: WebSocket[];
}

async function startUpstream(): Promise<FakeUpstream> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  const up: FakeUpstream = { port: (wss.address() as net.AddressInfo).port, received: [], urls: [], sockets: [] };
  wss.on('connection', (ws, req) => {
    up.urls.push(req.url ?? '');
    up.sockets.push(ws);
    ws.send(JSON.stringify({ type: 'frame', seq: 1, data: 'AAAA', metadata: { deviceWidth: 1280, deviceHeight: 720 } }));
    ws.on('message', (data) => up.received.push(data.toString()));
  });
  cleanups.push(() => new Promise<void>((r) => wss.close(() => r())));
  return up;
}

function makeDeps(upstreamPort: number | null): BrowserStreamDeps & { taken: Set<string>; inserted: string[] } {
  const taken = new Set<string>();
  const inserted: string[] = [];
  const sessions: BrowserSessionView[] = [
    { sessionId: 's1', device: 'server', state: 'ready', url: 'https://example.com/', title: 'Example', takenOver: false, lastUsedAt: 1 },
  ];
  return {
    taken,
    inserted,
    listSessions: () => sessions.map((s) => ({ ...s, takenOver: taken.has(s.sessionId) })),
    streamPort: async () => upstreamPort,
    setTakeover: (id, on) => { if (on) taken.add(id); else taken.delete(id); },
    isTakenOver: (id) => taken.has(id),
    insertText: async (_id, text) => { inserted.push(text); },
  };
}

const ALLOWED_ORIGIN = 'cortexui://localhost';

async function boot(deps: BrowserStreamDeps, opts?: BrowserStreamOptions): Promise<{ base: string; wsBase: string }> {
  const browser = createBrowserStream(deps, opts);
  const t = initTRPC.create();
  const ui = createUiHttpServer({
    router: t.router({}),
    getToken: () => TOKEN,
    port: 0,
    authorize: createAuthorizer({ getToken: () => TOKEN }),
    corsOrigins: [ALLOWED_ORIGIN],
    customRoutes: browser.routes,
    upgradeRoutes: { [BROWSER_STREAM_PATH]: browser },
    portForward: false,
  });
  if (!ui.server.listening) await new Promise<void>((r) => ui.server.once('listening', () => r()));
  cleanups.push(() => ui.close());
  const port = (ui.server.address() as net.AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = { 'x-cortex-token': TOKEN }) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  const json = text.startsWith('{') ? JSON.parse(text) as { ok: boolean; data?: Record<string, unknown>; code?: string } : { ok: false };
  return { status: res.status, body: json };
}

async function ticket(base: string, session = 's1', client?: string): Promise<string> {
  const { status, body } = await post(base, BROWSER_TICKET_PATH, { session, client });
  expect(status).toBe(200);
  return body.data!.ticket as string;
}

function openStream(url: string, origin?: string): Promise<{ ws: WebSocket; messages: string[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const messages: string[] = [];
    ws.on('message', (data) => messages.push(data.toString()));
    ws.once('open', () => resolve({ ws, messages }));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

describe('browser routes', () => {
  it('lists sessions behind the gate', async () => {
    const { base } = await boot(makeDeps(null));
    expect((await fetch(`${base}${BROWSER_SESSIONS_PATH}`)).status).toBe(401);
    const res = await fetch(`${base}${BROWSER_SESSIONS_PATH}`, { headers: { 'x-cortex-token': TOKEN } });
    const body = (await res.json()) as { data: { sessions: BrowserSessionView[] } };
    expect(body.data.sessions).toEqual([
      { sessionId: 's1', device: 'server', state: 'ready', url: 'https://example.com/', title: 'Example', takenOver: false, lastUsedAt: 1 },
    ]);
  });

  it('mints tickets only for a session that holds a browser, and only for a trusted page', async () => {
    const { base } = await boot(makeDeps(null));
    expect((await post(base, BROWSER_TICKET_PATH, { session: 'nope' })).status).toBe(404);
    expect((await post(base, BROWSER_TICKET_PATH, { session: 's1' }, {})).status).toBe(401);
    const foreign = await post(base, BROWSER_TICKET_PATH, { session: 's1' }, { 'x-cortex-token': TOKEN, origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
  });

  it('toggles takeover and inserts text only while taken over', async () => {
    const deps = makeDeps(null);
    const { base } = await boot(deps);
    expect((await post(base, BROWSER_INSERT_TEXT_PATH, { session: 's1', text: '你好' })).body.code).toBe('not-taken-over');
    expect((await post(base, BROWSER_TAKEOVER_PATH, { session: 's1', on: true })).body.code).toBe('bad-client');
    expect((await post(base, BROWSER_TICKET_PATH, { session: 's1', client: 'a b' })).body.code).toBe('bad-client');
    const on = await post(base, BROWSER_TAKEOVER_PATH, { session: 's1', on: true, client: 'w1' });
    expect(on.body.data).toEqual({ takenOver: true });
    expect((await post(base, BROWSER_INSERT_TEXT_PATH, { session: 's1', text: '你好' })).status).toBe(200);
    expect(deps.inserted).toEqual(['你好']);
    expect((await post(base, BROWSER_TAKEOVER_PATH, { session: 's1', on: 'yes' })).status).toBe(400);
    const off = await post(base, BROWSER_TAKEOVER_PATH, { session: 's1', on: false });
    expect(off.body.data).toEqual({ takenOver: false });
  });
});

describe('browser stream proxy', () => {
  it('refuses a handshake without a valid ticket, or from a foreign page', async () => {
    const up = await startUpstream();
    const { base, wsBase } = await boot(makeDeps(up.port));
    await expect(openStream(`${wsBase}${BROWSER_STREAM_PATH}?session=s1&ticket=forged`)).rejects.toThrow('status 401');
    const t = await ticket(base);
    await expect(openStream(`${wsBase}${BROWSER_STREAM_PATH}?session=s1&ticket=${t}`, 'https://evil.example')).rejects.toThrow('status 403');
  });

  it('relays frames, paces with acks, and forwards input only from the holding window', async () => {
    const up = await startUpstream();
    const deps = makeDeps(up.port);
    const { base, wsBase } = await boot(deps);
    const url = async (client: string) => `${wsBase}${BROWSER_STREAM_PATH}?session=s1&ticket=${await ticket(base, 's1', client)}&maxFps=4`;
    const mine = await openStream(await url('w1'), ALLOWED_ORIGIN);
    const other = await openStream(await url('w2'), ALLOWED_ORIGIN);
    const frames = (m: string[]) => m.filter((x) => JSON.parse(x).type === 'frame');
    await vi.waitFor(() => expect(frames(mine.messages).length).toBe(1));
    expect(JSON.parse(mine.messages[0]!)).toEqual({ type: TAKEOVER_MESSAGE, takenOver: false, mine: false });
    expect(up.urls[0]).toBe('/?maxFps=4&pacing=ack');

    const click = JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 1 });
    mine.ws.send(JSON.stringify({ type: 'ack', seq: 1 }));
    mine.ws.send(click);
    await vi.waitFor(() => expect(up.received).toEqual(['{"type":"ack","seq":1}']));

    await post(base, BROWSER_TAKEOVER_PATH, { session: 's1', on: true, client: 'w1' });
    await vi.waitFor(() => expect(JSON.parse(other.messages.at(-1)!)).toEqual({ type: TAKEOVER_MESSAGE, takenOver: true, mine: false }));
    expect(JSON.parse(mine.messages.at(-1)!)).toEqual({ type: TAKEOVER_MESSAGE, takenOver: true, mine: true });
    other.ws.send(click);
    other.ws.send(JSON.stringify({ type: 'ack', seq: 9 }));
    await vi.waitFor(() => expect(up.received.at(-1)).toBe('{"type":"ack","seq":9}'));
    mine.ws.send(click);
    await vi.waitFor(() => expect(up.received.at(-1)).toBe(click));
    expect(up.received.filter((m) => m === click)).toHaveLength(1);

    mine.ws.close();
    other.ws.close();
    await Promise.all([closed(mine.ws), closed(other.ws)]);
  });

  it('hands the page back when the holding window is gone past the grace, and announces it', async () => {
    const up = await startUpstream();
    const deps = makeDeps(up.port);
    const { base, wsBase } = await boot(deps, { graceMs: 150 });
    const open = async (client: string) => openStream(`${wsBase}${BROWSER_STREAM_PATH}?session=s1&ticket=${await ticket(base, 's1', client)}`);
    const watcher = await open('w2');
    let holder = await open('w1');
    await post(base, BROWSER_TAKEOVER_PATH, { session: 's1', on: true, client: 'w1' });
    // A reload: the window's stream drops and comes back within the grace.
    holder.ws.close();
    await closed(holder.ws);
    holder = await open('w1');
    await new Promise((r) => setTimeout(r, 300));
    expect(deps.taken.has('s1')).toBe(true);
    // Gone for good.
    holder.ws.close();
    await closed(holder.ws);
    await vi.waitFor(() => expect(deps.taken.has('s1')).toBe(false));
    await vi.waitFor(() => expect(JSON.parse(watcher.messages.at(-1)!)).toEqual({ type: TAKEOVER_MESSAGE, takenOver: false, mine: false }));
    watcher.ws.close();
  });

  it('hands the page back after a stretch without input', async () => {
    const up = await startUpstream();
    const deps = makeDeps(up.port);
    const { base, wsBase } = await boot(deps, { idleMs: 300 });
    const holder = await openStream(`${wsBase}${BROWSER_STREAM_PATH}?session=s1&ticket=${await ticket(base, 's1', 'w1')}`);
    await post(base, BROWSER_TAKEOVER_PATH, { session: 's1', on: true, client: 'w1' });
    const move = JSON.stringify({ type: 'input_mouse', eventType: 'mouseMoved', x: 1, y: 1, button: 'none', clickCount: 0 });
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 150));
      holder.ws.send(move); // keeps it alive past the idle span
    }
    expect(deps.taken.has('s1')).toBe(true);
    await vi.waitFor(() => expect(deps.taken.has('s1')).toBe(false), { timeout: 2000 });
    await vi.waitFor(() => expect(JSON.parse(holder.messages.at(-1)!)).toMatchObject({ type: TAKEOVER_MESSAGE, takenOver: false }));
    holder.ws.close();
  });

  it('closes with a distinct code when the session has no stream', async () => {
    const { base, wsBase } = await boot(makeDeps(null));
    const { ws } = await openStream(`${wsBase}${BROWSER_STREAM_PATH}?session=s1&ticket=${await ticket(base)}`);
    expect(await closed(ws)).toBe(CLOSE_NO_STREAM);
  });

  it('tells the viewer when the upstream goes away', async () => {
    const up = await startUpstream();
    const { base, wsBase } = await boot(makeDeps(up.port));
    const { ws, messages } = await openStream(`${wsBase}${BROWSER_STREAM_PATH}?session=s1&ticket=${await ticket(base)}`);
    await vi.waitFor(() => expect(messages.length).toBe(2));
    const gone = closed(ws);
    up.sockets[0]!.close();
    expect(await gone).toBe(CLOSE_UPSTREAM_GONE);
  });
});
