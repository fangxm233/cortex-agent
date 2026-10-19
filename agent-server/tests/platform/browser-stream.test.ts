import { describe, it, expect, afterAll, vi } from 'vitest';
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
  admitClientMessage,
  clampFps,
  createBrowserStream,
  createTicketStore,
  parseStreamTarget,
  type BrowserSessionView,
  type BrowserStreamDeps,
} from '@platform/ui-http/browser-stream.js';

const TOKEN = 'browser-stream-test-token';

describe('admitClientMessage', () => {
  it('passes acks, normalised, whoever holds the page', () => {
    expect(admitClientMessage('{"type":"ack","seq":7,"x":1}', false)).toBe('{"type":"ack","seq":7}');
    expect(admitClientMessage('{"type":"ack","seq":"7"}', true)).toBeNull();
  });

  it('passes input only while the page is taken over', () => {
    const click = JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 });
    expect(admitClientMessage(click, false)).toBeNull();
    expect(admitClientMessage(click, true)).toBe(click);
    const key = JSON.stringify({ type: 'input_keyboard', eventType: 'keyDown', key: 'a', code: 'KeyA' });
    expect(admitClientMessage(key, true)).toBe(key);
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
  it('spends a ticket once, for its own session only', () => {
    const store = createTicketStore();
    const a = store.mint('s1');
    expect(store.redeem(a, 's2')).toBe(false);
    expect(store.redeem(a, 's1')).toBe(false); // spent by the failed attempt
    const b = store.mint('s1');
    expect(store.redeem(b, 's1')).toBe(true);
    expect(store.redeem(b, 's1')).toBe(false);
    expect(store.redeem('', 's1')).toBe(false);
  });

  it('expires', () => {
    let t = 1_000;
    const store = createTicketStore(() => t);
    const a = store.mint('s1');
    t += 31_000;
    expect(store.redeem(a, 's1')).toBe(false);
    expect(store.size()).toBe(0);
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

async function boot(deps: BrowserStreamDeps): Promise<{ base: string; wsBase: string }> {
  const browser = createBrowserStream(deps);
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

async function ticket(base: string, session = 's1'): Promise<string> {
  const { status, body } = await post(base, BROWSER_TICKET_PATH, { session });
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
    const on = await post(base, BROWSER_TAKEOVER_PATH, { session: 's1', on: true });
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

  it('relays frames, paces with acks, and forwards input only during takeover', async () => {
    const up = await startUpstream();
    const deps = makeDeps(up.port);
    const { base, wsBase } = await boot(deps);
    const { ws, messages } = await openStream(`${wsBase}${BROWSER_STREAM_PATH}?session=s1&ticket=${await ticket(base)}&maxFps=4`, ALLOWED_ORIGIN);
    await vi.waitFor(() => expect(messages.length).toBe(1));
    expect(JSON.parse(messages[0]!).type).toBe('frame');
    expect(up.urls[0]).toBe('/?maxFps=4&pacing=ack');

    const click = JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', x: 5, y: 6, button: 'left', clickCount: 1 });
    ws.send(JSON.stringify({ type: 'ack', seq: 1 }));
    ws.send(click);
    ws.send(JSON.stringify({ type: 'ack', seq: 2 }));
    await vi.waitFor(() => expect(up.received.length).toBe(2));
    deps.taken.add('s1');
    ws.send(click);
    await vi.waitFor(() => expect(up.received.length).toBe(3));
    expect(up.received).toEqual(['{"type":"ack","seq":1}', '{"type":"ack","seq":2}', click]);

    // A ticket is spent by the handshake.
    ws.close();
    await closed(ws);
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
    await vi.waitFor(() => expect(messages.length).toBe(1));
    const gone = closed(ws);
    up.sockets[0]!.close();
    expect(await gone).toBe(CLOSE_UPSTREAM_GONE);
  });
});
